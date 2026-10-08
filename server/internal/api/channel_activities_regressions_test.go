package api

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func activityRegressionCommunity(t *testing.T, s *PostgresStore, users []User) Community {
	t.Helper()
	c, err := s.CreateCommunity(users[0].ID, "Activity regressions", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range users[1:] {
		socialFriend(t, s, users[0].ID, user.ID)
		if err = s.AddCommunityMember(c.ID, users[0].ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	return c
}

func activityRegressionAttachment(t *testing.T, s *PostgresStore, room, user, mime string, posted bool) (string, string) {
	t.Helper()
	id, err := randomAttachmentID()
	if err != nil {
		t.Fatal(err)
	}
	a := MessageAttachment{ID: id, Filename: "activity-file", ContentType: mime, SizeBytes: 100}
	if err = s.SavePendingAttachment(room, user, "activities/regression/"+id, a); err != nil {
		t.Fatal(err)
	}
	if err = s.CompletePendingAttachment(id, room); err != nil {
		t.Fatal(err)
	}
	if !posted {
		return id, ""
	}
	m, _, err := s.SendMessage(room, user, "Shared activity file", "", "", []string{id})
	if err != nil {
		t.Fatal(err)
	}
	return id, m.ID
}

func activityRegressionSticker(t *testing.T, s *PostgresStore, room, user string) ChannelMediaAsset {
	t.Helper()
	id, _ := activityRegressionAttachment(t, s, room, user, "image/png", false)
	if err := s.CreateChannelMediaAsset(room, user, id, "Victory", "sticker", nil); err != nil {
		t.Fatal(err)
	}
	var assetID string
	if err := s.DB.QueryRow(context.Background(), `SELECT id::text FROM channel_media_assets WHERE attachment_id=$1`, id).Scan(&assetID); err != nil {
		t.Fatal(err)
	}
	a, err := s.ChannelMediaAsset(room, user, assetID)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func activityRegressionWaitBlocked(t *testing.T, s *PostgresStore, blocker int, done <-chan error) {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(10 * time.Millisecond)
	defer poll.Stop()
	for {
		select {
		case err := <-done:
			t.Fatalf("activity finished before reaching the held lock: %v", err)
		case <-deadline.C:
			t.Fatal("activity never waited on the held database lock")
		case <-poll.C:
			var waiting bool
			if err := s.DB.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				return
			}
		}
	}
}

func activityRegressionWaitDone(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("activity did not finish after the held lock was released")
		return nil
	}
}

func TestStickerAndOrdinaryMessageLockOrderIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 2)
	c := activityRegressionCommunity(t, s, users)
	room, user := c.Channels[0].ID, users[1].ID
	asset := activityRegressionSticker(t, s, room, users[0].ID)
	nonce, err := randomAttachmentID()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	writer, err := s.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(ctx)
	if err = lockRoomCommunity(ctx, writer, room); err != nil {
		t.Fatal(err)
	}
	var pid int
	if err = writer.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err = writer.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))`, room); err != nil {
		t.Fatal(err)
	}
	var sticker Message
	done := make(chan error, 1)
	go func() {
		var sendErr error
		sticker, _, sendErr = s.SendStickerMessage(strings.ToUpper(room), user, asset.ID, nonce)
		done <- sendErr
	}()
	activityRegressionWaitBlocked(t, s, pid, done)
	// This is the next lock taken by an ordinary writer. A sticker must not
	// hold membership while waiting on the room order lock held by that writer.
	probe, cancel := context.WithTimeout(ctx, time.Second)
	var locked string
	err = writer.QueryRow(probe, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 FOR UPDATE`, room, user).Scan(&locked)
	cancel()
	if err != nil {
		t.Fatalf("sticker held membership before acquiring room order: %v", err)
	}
	ordinaryDone := make(chan error, 1)
	go func() {
		_, writeErr := s.WriteMessage(room, user, "", "Ordinary concurrent message", "")
		ordinaryDone <- writeErr
	}()
	if err = writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = activityRegressionWaitDone(t, done); err != nil {
		t.Fatal(err)
	}
	if err = activityRegressionWaitDone(t, ordinaryDone); err != nil {
		t.Fatal(err)
	}
	retry, created, err := s.SendStickerMessage(room, user, asset.ID, nonce)
	if err != nil || created || retry.ID != sticker.ID {
		t.Fatalf("concurrent sticker retry lost idempotency: %+v %v %v", retry, created, err)
	}
	var count int
	if err = s.DB.QueryRow(ctx, `SELECT count(*) FROM messages WHERE room_id=$1`, room).Scan(&count); err != nil || count != 2 {
		t.Fatalf("expected one sticker and one ordinary message, got %d: %v", count, err)
	}
	if err = s.SetChannelAccess(c.ID, room, users[0].ID, ChannelAccess{Overrides: []ChannelOverride{{SubjectKey: "member", Permissions: map[string]string{"post": "deny"}}}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.SendStickerMessage(room, user, asset.ID, nonce); !errors.Is(err, ErrForbidden) {
		t.Fatalf("retry bypassed revoked posting permission: %v", err)
	}
}

func TestActivityAssetsAndCleanupLockOrderIntegration(t *testing.T) {
	for _, action := range []string{"remove", "send"} {
		t.Run(action, func(t *testing.T) {
			s := conversationTestStore(t)
			users := socialUsers(t, s, 1)
			c := activityRegressionCommunity(t, s, users)
			room, user := c.Channels[0].ID, users[0].ID
			asset := activityRegressionSticker(t, s, room, user)
			ctx := context.Background()
			cleanup, err := s.DB.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup.Rollback(ctx)
			var pid int
			if err = cleanup.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			if _, err = cleanup.Exec(ctx, `UPDATE message_attachments SET deleted_at=clock_timestamp() WHERE id=$1`, asset.Attachment.ID); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				var activityErr error
				if action == "remove" {
					activityErr = s.DeleteChannelMediaAsset(room, user, asset.ID)
				} else {
					nonce, nonceErr := randomAttachmentID()
					if nonceErr != nil {
						done <- nonceErr
						return
					}
					_, _, activityErr = s.SendStickerMessage(room, user, asset.ID, nonce)
				}
				done <- activityErr
			}()
			activityRegressionWaitBlocked(t, s, pid, done)
			// Physical cleanup owns the attachment and cascades into assets. A
			// waiting activity must not already own the asset row in reverse order.
			probe, cancel := context.WithTimeout(ctx, time.Second)
			_, err = cleanup.Exec(probe, `DELETE FROM message_attachments WHERE id=$1`, asset.Attachment.ID)
			cancel()
			if err != nil {
				t.Fatalf("activity inverted cleanup attachment/asset order: %v", err)
			}
			if err = cleanup.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err = activityRegressionWaitDone(t, done); !errors.Is(err, ErrNotFound) {
				t.Fatalf("activity on a removed source: %v", err)
			}
		})
	}
}

func TestWatchTogetherUnavailableSourceReplacementIntegration(t *testing.T) {
	cases := []struct {
		name   string
		remove func(*PostgresStore, string, string, string, string) error
	}{
		{"message deletion", func(s *PostgresStore, room, user, _, message string) error {
			_, err := s.DeleteMessage(room, user, message)
			return err
		}},
		{"library attachment deletion", func(s *PostgresStore, room, user, attachment, _ string) error {
			_, _, err := s.DeleteLibraryFile(context.Background(), room, user, attachment)
			return err
		}},
		{"scan rejection", func(s *PostgresStore, _, _, attachment, _ string) error {
			_, err := s.DB.Exec(context.Background(), `UPDATE message_attachments SET scan_state='rejected' WHERE id=$1`, attachment)
			return err
		}},
		{"physical attachment deletion", func(s *PostgresStore, _, _, attachment, _ string) error {
			_, err := s.DB.Exec(context.Background(), `DELETE FROM message_attachments WHERE id=$1`, attachment)
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := conversationTestStore(t)
			users := socialUsers(t, s, 2)
			c := activityRegressionCommunity(t, s, users)
			room, owner, member := c.Channels[0].ID, users[0].ID, users[1].ID
			first, message := activityRegressionAttachment(t, s, room, owner, "video/mp4", true)
			second, secondMessage := activityRegressionAttachment(t, s, room, member, "video/mp4", true)
			state, err := s.ChangeWatchTogether(room, owner, WatchTogetherCommand{Action: "start", AttachmentID: first})
			if err != nil {
				t.Fatal(err)
			}
			state, err = s.ChangeWatchTogether(room, owner, WatchTogetherCommand{Action: "play", Revision: state.Revision})
			if err != nil {
				t.Fatal(err)
			}
			if err = tc.remove(s, room, owner, first, message); err != nil {
				t.Fatal(err)
			}
			snapshot, err := s.ChannelActivities(room, member)
			if err != nil || snapshot.Watch != nil {
				t.Fatalf("unavailable video remained visible: %+v %v", snapshot.Watch, err)
			}
			// The visible snapshot says there is no session, so another eligible
			// participant starts at revision 0 without inheriting the hidden host.
			state, err = s.ChangeWatchTogether(room, member, WatchTogetherCommand{Action: "start", AttachmentID: second})
			if err != nil || state == nil || state.Revision != 1 || state.HostID == nil || *state.HostID != member || state.Attachment.ID != second {
				t.Fatalf("hidden watch blocked replacement: %+v %v", state, err)
			}
			if _, err = s.ChangeWatchTogether(room, owner, WatchTogetherCommand{Action: "play", Revision: state.Revision}); !errors.Is(err, ErrForbidden) {
				t.Fatalf("previous host retained control of replacement: %v", err)
			}
			if _, err = s.ChangeWatchTogether(room, owner, WatchTogetherCommand{Action: "start", AttachmentID: second}); !errors.Is(err, ErrConflict) {
				t.Fatalf("another revision-0 start bypassed replacement CAS: %v", err)
			}
			if err = tc.remove(s, room, member, second, secondMessage); err != nil {
				t.Fatal(err)
			}
			if _, err = s.ChangeWatchTogether(room, member, WatchTogetherCommand{Action: "heartbeat", Revision: state.Revision}); !errors.Is(err, ErrNotFound) {
				t.Fatalf("unavailable watch accepted host heartbeat: %v", err)
			}
			var count int
			if err = s.DB.QueryRow(context.Background(), `SELECT count(*) FROM channel_watch_sessions WHERE room_id=$1`, room).Scan(&count); err != nil || count != 0 {
				t.Fatalf("unavailable host lease retained: %d %v", count, err)
			}
		})
	}
}

func TestWatchTogetherAndFileDeletionLockOrderIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 1)
	c := activityRegressionCommunity(t, s, users)
	room, user := c.Channels[0].ID, users[0].ID
	attachment, message := activityRegressionAttachment(t, s, room, user, "video/mp4", true)
	ctx := context.Background()
	deletion, err := s.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(ctx)
	var pid int
	if err = deletion.QueryRow(ctx, `SELECT pg_backend_pid() FROM messages WHERE id=$1 FOR UPDATE`, message).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, startErr := s.ChangeWatchTogether(room, user, WatchTogetherCommand{Action: "start", AttachmentID: attachment})
		done <- startErr
	}()
	activityRegressionWaitBlocked(t, s, pid, done)
	probe, cancel := context.WithTimeout(ctx, time.Second)
	_, err = deletion.Exec(probe, `UPDATE message_attachments SET deleted_at=clock_timestamp() WHERE id=$1`, attachment)
	cancel()
	if err != nil {
		t.Fatalf("watch start locked attachment before parent message: %v", err)
	}
	if err = deletion.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = activityRegressionWaitDone(t, done); !errors.Is(err, ErrNotFound) {
		t.Fatalf("watch started on a concurrently deleted file: %v", err)
	}
}

func TestWatchTogetherAndAttachmentCleanupLockOrderIntegration(t *testing.T) {
	for _, ownerless := range []bool{false, true} {
		name := "concurrent deletion"
		if ownerless {
			name = "ownerless cleanup batch"
		}
		t.Run(name, func(t *testing.T) {
			s := conversationTestStore(t)
			users := socialUsers(t, s, 2)
			c := activityRegressionCommunity(t, s, users)
			room, owner, member := c.Channels[0].ID, users[0].ID, users[1].ID
			first, _ := activityRegressionAttachment(t, s, room, owner, "video/mp4", true)
			second, _ := activityRegressionAttachment(t, s, room, member, "video/mp4", true)
			state, err := s.ChangeWatchTogether(room, owner, WatchTogetherCommand{Action: "start", AttachmentID: first})
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			if ownerless {
				if _, err = s.DB.Exec(ctx, `UPDATE message_attachments SET uploader_id=NULL WHERE id=ANY($1::uuid[])`, []string{first, second}); err != nil {
					t.Fatal(err)
				}
			}
			cleanup, err := s.DB.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup.Rollback(ctx)
			var pid int
			if err = cleanup.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			// The worker locks its whole attachment batch before each cascading
			// deletion. Include both the old session source and replacement.
			if _, err = cleanup.Exec(ctx, `UPDATE message_attachments SET deleted_at=clock_timestamp() WHERE id=ANY($1::uuid[])`, []string{first, second}); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				revision := state.Revision
				if ownerless {
					revision = 0
				}
				_, startErr := s.ChangeWatchTogether(room, owner, WatchTogetherCommand{Action: "start", AttachmentID: second, Revision: revision})
				done <- startErr
			}()
			if ownerless {
				if err = activityRegressionWaitDone(t, done); !errors.Is(err, ErrNotFound) {
					t.Fatalf("ownerless published video accepted as a target: %v", err)
				}
			} else {
				activityRegressionWaitBlocked(t, s, pid, done)
			}
			probe, cancel := context.WithTimeout(ctx, time.Second)
			_, err = cleanup.Exec(probe, `DELETE FROM message_attachments WHERE id=$1`, first)
			cancel()
			if err != nil {
				t.Fatalf("watch locked session before a replacement source in cleanup's batch: %v", err)
			}
			if err = cleanup.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if !ownerless {
				if err = activityRegressionWaitDone(t, done); !errors.Is(err, ErrNotFound) {
					t.Fatalf("watch accepted the concurrently deleted target: %v", err)
				}
			}
		})
	}
}

func TestWatchTogetherAccountDeletionLockOrderIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 2)
	c := activityRegressionCommunity(t, s, users)
	room, user := c.Channels[0].ID, users[1].ID
	attachment, message := activityRegressionAttachment(t, s, room, user, "video/mp4", true)
	ctx := context.Background()
	deletion, err := s.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(ctx)
	// Reproduce DeleteAccount's group guard, user, message, attachment, and
	// membership ordering. Watch must wait before owning that membership.
	if err = lockGroupMembership(ctx, deletion); err != nil {
		t.Fatal(err)
	}
	var pid int
	if err = deletion.QueryRow(ctx, `SELECT pg_backend_pid() FROM users WHERE id=$1 FOR UPDATE`, user).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err = deletion.Exec(ctx, `UPDATE messages SET deleted_at=clock_timestamp(),body='' WHERE id=$1`, message); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, startErr := s.ChangeWatchTogether(room, user, WatchTogetherCommand{Action: "start", AttachmentID: attachment})
		done <- startErr
	}()
	activityRegressionWaitBlocked(t, s, pid, done)
	probe, cancel := context.WithTimeout(ctx, time.Second)
	_, err = deletion.Exec(probe, `DELETE FROM room_members WHERE room_id=$1 AND user_id=$2`, room, user)
	cancel()
	if err != nil {
		t.Fatalf("watch held membership while waiting for account deletion: %v", err)
	}
	if _, err = deletion.Exec(ctx, `UPDATE message_attachments SET deleted_at=clock_timestamp(),uploader_id=NULL WHERE id=$1`, attachment); err != nil {
		t.Fatal(err)
	}
	if _, err = deletion.Exec(ctx, `UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1`, user); err != nil {
		t.Fatal(err)
	}
	if err = deletion.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = activityRegressionWaitDone(t, done); !errors.Is(err, ErrForbidden) {
		t.Fatalf("deleted account started watch: %v", err)
	}
}

func TestActivityModerationWithoutPostingIntegration(t *testing.T) {
	for _, channelType := range []string{"hybrid", "announcement"} {
		t.Run(channelType, func(t *testing.T) {
			s := conversationTestStore(t)
			users := socialUsers(t, s, 5)
			// Keep the last account outside the community for read authorization.
			c := activityRegressionCommunity(t, s, users[:4])
			owner, moderator, author, reader, outsider := users[0].ID, users[1].ID, users[2].ID, users[3].ID, users[4].ID
			room := c.Channels[0].ID
			if err := s.SetCommunityRole(c.ID, owner, moderator, "moderator"); err != nil {
				t.Fatal(err)
			}
			for _, creator := range []string{owner, author} {
				if err := s.CreateChannelPoll(room, creator, "Choose an activity", []string{"Movie", "Game"}, nil); err != nil {
					t.Fatal(err)
				}
				if err := s.CreateScheduledEvent(room, creator, "Activity night", "", time.Now().Add(time.Hour)); err != nil {
					t.Fatal(err)
				}
				activityRegressionSticker(t, s, room, creator)
			}
			if channelType == "announcement" {
				if _, err := s.UpdateChannel(c.ID, room, owner, ChannelUpdate{ChannelType: &channelType}); err != nil {
					t.Fatal(err)
				}
			} else if err := s.SetChannelAccess(c.ID, room, owner, ChannelAccess{Overrides: []ChannelOverride{{SubjectKey: "member", Permissions: map[string]string{"post": "deny"}}, {SubjectKey: "moderator", Permissions: map[string]string{"post": "deny"}}}}); err != nil {
				t.Fatal(err)
			}
			resolved, err := s.RoomForMember(room, moderator)
			if err != nil || resolved.Permissions.Post || !resolved.Permissions.Moderate {
				t.Fatalf("test requires readable, posting-denied moderator: %+v %v", resolved.Permissions, err)
			}
			snapshot, err := s.ChannelActivities(room, moderator)
			if err != nil {
				t.Fatal(err)
			}
			for _, poll := range snapshot.Polls {
				actor := moderator
				if poll.AuthorID != nil && *poll.AuthorID == author {
					actor = author
				}
				for _, denied := range []string{reader, outsider} {
					if err = s.CloseChannelPoll(room, denied, poll.ID); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrForbidden) {
						t.Fatalf("unauthorized account closed poll: %v", err)
					}
				}
				if err = s.CloseChannelPoll(room, actor, poll.ID); err != nil {
					t.Fatalf("posting-denied author/moderator could not close poll: %v", err)
				}
			}
			for _, event := range snapshot.Events {
				actor := moderator
				if event.AuthorID != nil && *event.AuthorID == author {
					actor = author
				}
				for _, denied := range []string{reader, outsider} {
					if err = s.CancelScheduledEvent(room, denied, event.ID); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrForbidden) {
						t.Fatalf("unauthorized account cancelled event: %v", err)
					}
				}
				if err = s.CancelScheduledEvent(room, actor, event.ID); err != nil {
					t.Fatalf("posting-denied author/moderator could not cancel event: %v", err)
				}
			}
			for _, asset := range snapshot.Assets {
				actor := moderator
				if asset.CreatorID != nil && *asset.CreatorID == author {
					actor = author
				}
				for _, denied := range []string{reader, outsider} {
					if err = s.DeleteChannelMediaAsset(room, denied, asset.ID); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrForbidden) {
						t.Fatalf("unauthorized account removed asset: %v", err)
					}
				}
				if err = s.DeleteChannelMediaAsset(room, actor, asset.ID); err != nil {
					t.Fatalf("posting-denied author/moderator could not remove asset: %v", err)
				}
			}
			pending, _ := activityRegressionAttachment(t, s, room, owner, "image/png", false)
			for _, denied := range []string{moderator, author} {
				if err = s.CreateChannelPoll(room, denied, "Still posting", []string{"One", "Two"}, nil); !errors.Is(err, ErrForbidden) {
					t.Fatalf("posting-denied actor created poll: %v", err)
				}
				if err = s.CreateScheduledEvent(room, denied, "Still posting", "", time.Now().Add(time.Hour)); !errors.Is(err, ErrForbidden) {
					t.Fatalf("posting-denied actor created event: %v", err)
				}
				if err = s.CreateChannelMediaAsset(room, denied, pending, "Still posting", "sticker", nil); !errors.Is(err, ErrForbidden) {
					t.Fatalf("posting-denied actor registered asset: %v", err)
				}
			}
			// Moderation alone never grants read access to a denied channel.
			if err = s.CreateChannelPoll(room, owner, "Private poll", []string{"One", "Two"}, nil); err != nil {
				t.Fatal(err)
			}
			snapshot, err = s.ChannelActivities(room, owner)
			if err != nil {
				t.Fatal(err)
			}
			if err = s.SetChannelAccess(c.ID, room, owner, ChannelAccess{Overrides: []ChannelOverride{{SubjectKey: "moderator", Permissions: map[string]string{"read": "deny"}}}}); err != nil {
				t.Fatal(err)
			}
			if err = s.CloseChannelPoll(room, moderator, snapshot.Polls[0].ID); !errors.Is(err, ErrForbidden) {
				t.Fatalf("moderator bypassed read revocation: %v", err)
			}
		})
	}
}
