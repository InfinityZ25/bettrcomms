package api

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"
)

func TestActivityInputValidation(t *testing.T) {
	now := time.Now()
	future := now.Add(time.Hour)
	if !validPoll("What game?", []string{"First", "Second"}, &future, now) {
		t.Fatal("valid poll rejected")
	}
	for _, options := range [][]string{{"Only one"}, {"Same", " same "}, {"", "Second"}} {
		if validPoll("What game?", options, nil, now) {
			t.Fatalf("invalid options accepted: %v", options)
		}
	}
	past := now.Add(-time.Second)
	if validPoll("What game?", []string{"First", "Second"}, &past, now) {
		t.Fatal("past deadline accepted")
	}
	for _, value := range []float64{math.NaN(), math.Inf(1), -1, 604801} {
		if validWatchCommand(WatchTogetherCommand{Action: "seek", PositionSeconds: value}) {
			t.Fatalf("invalid watch position accepted: %v", value)
		}
	}
	if validWatchCommand(WatchTogetherCommand{Action: "start", AttachmentID: "https://untrusted.example/video"}) {
		t.Fatal("external watch source accepted")
	}
	if validWatchCommand(WatchTogetherCommand{Action: "unknown"}) {
		t.Fatal("unknown command accepted")
	}
	if !validWatchCommand(WatchTogetherCommand{Action: "seek", PositionSeconds: 12, Revision: 2}) {
		t.Fatal("valid seek rejected")
	}
}

func TestChannelPollEventAndHistoryIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 3)
	owner, member, outsider := users[0], users[1], users[2]
	c, err := s.CreateCommunity(owner.ID, "Activity friends", "", "hangout")
	if err != nil {
		t.Fatal(err)
	}
	room := c.Channels[0].ID
	socialFriend(t, s, owner.ID, member.ID)
	if err = s.AddCommunityMember(c.ID, owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.CreateChannelPoll(room, owner.ID, "Tonight?", []string{"Game", "Movie"}, nil); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.ChannelActivities(room, member.ID)
	if err != nil || len(snapshot.Polls) != 1 {
		t.Fatalf("poll read: %+v %v", snapshot, err)
	}
	poll := snapshot.Polls[0]
	option := 1
	if err = s.VoteChannelPoll(room, member.ID, poll.ID, &option); err != nil {
		t.Fatal(err)
	}
	if err = s.VoteChannelPoll(room, member.ID, poll.ID, &option); err != nil {
		t.Fatal(err)
	}
	snapshot, err = s.ChannelActivities(room, member.ID)
	if err != nil || snapshot.Polls[0].Counts[1] != 1 || snapshot.Polls[0].Vote == nil || *snapshot.Polls[0].Vote != 1 {
		t.Fatalf("vote was not unique: %+v %v", snapshot, err)
	}
	option = 10
	if err = s.VoteChannelPoll(room, member.ID, poll.ID, &option); !errors.Is(err, ErrForbidden) {
		t.Fatalf("invalid option: %v", err)
	}
	if _, err = s.ChannelActivities(room, outsider.ID); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrForbidden) {
		t.Fatalf("outsider read: %v", err)
	}
	if err = s.CloseChannelPoll(room, member.ID, poll.ID); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrForbidden) {
		t.Fatalf("member closed somebody else's poll: %v", err)
	}
	if err = s.CloseChannelPoll(room, owner.ID, poll.ID); err != nil {
		t.Fatal(err)
	}
	option = 0
	if err = s.VoteChannelPoll(room, member.ID, poll.ID, &option); !errors.Is(err, ErrConflict) {
		t.Fatalf("closed poll accepted vote: %v", err)
	}
	if err = s.CreateScheduledEvent(room, owner.ID, "Movie night", "Bring popcorn", time.Now().Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	snapshot, err = s.ChannelActivities(room, member.ID)
	if err != nil || len(snapshot.Events) != 1 {
		t.Fatalf("event read: %+v %v", snapshot, err)
	}
	event := snapshot.Events[0]
	if err = s.RSVPScheduledEvent(room, member.ID, event.ID, "maybe"); err != nil {
		t.Fatal(err)
	}
	first, err := s.EventReminders(member.ID)
	if err != nil || len(first) != 1 {
		t.Fatalf("due reminder: %+v %v", first, err)
	}
	second, err := s.EventReminders(member.ID)
	if err != nil || len(second) != 1 || second[0].ID != first[0].ID {
		t.Fatalf("reminder duplicated: %+v %v", second, err)
	}
	if err = s.AcknowledgeEventReminder(member.ID, first[0].ID); err != nil {
		t.Fatal(err)
	}
	second, err = s.EventReminders(member.ID)
	if err != nil || len(second) != 0 {
		t.Fatalf("dismissed reminder reappeared: %+v %v", second, err)
	}
	if err = s.CancelScheduledEvent(room, owner.ID, event.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.RSVPScheduledEvent(room, member.ID, event.ID, "going"); !errors.Is(err, ErrConflict) {
		t.Fatalf("cancelled event accepted RSVP: %v", err)
	}
	m, err := s.WriteMessage(room, member.ID, "", "Original text", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.WriteMessage(room, member.ID, m.ID, "Edited text", ""); err != nil {
		t.Fatal(err)
	}
	versions, err := s.MessageEditHistory(room, owner.ID, m.ID)
	if err != nil || len(versions) != 2 || versions[0].Body != "Edited text" || versions[1].Body != "Original text" {
		t.Fatalf("edit history: %+v %v", versions, err)
	}
	if _, err = s.MessageEditHistory(room, outsider.ID, m.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider read history: %v", err)
	}
	if _, err = s.DeleteMessage(room, member.ID, m.ID); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = s.DB.QueryRow(context.Background(), `SELECT count(*) FROM message_edit_history WHERE message_id=$1`, m.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("delete retained historical text: %d %v", count, err)
	}
}

func TestWatchTogetherAndReusableStickerIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 3)
	owner, member, outsider := users[0], users[1], users[2]
	c, err := s.CreateCommunity(owner.ID, "Video friends", "", "movies")
	if err != nil {
		t.Fatal(err)
	}
	room := c.Channels[0].ID
	socialFriend(t, s, owner.ID, member.ID)
	if err = s.AddCommunityMember(c.ID, owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	stickerID, err := randomAttachmentID()
	if err != nil {
		t.Fatal(err)
	}
	sticker := MessageAttachment{ID: stickerID, Filename: "victory.png", ContentType: "image/png", SizeBytes: 100}
	if err = s.SavePendingAttachment(room, owner.ID, "activities/test/"+stickerID, sticker); err != nil {
		t.Fatal(err)
	}
	if err = s.CompletePendingAttachment(stickerID, room); err != nil {
		t.Fatal(err)
	}
	if err = s.CreateChannelMediaAsset(room, owner.ID, stickerID, "Victory", "sticker", nil); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.ChannelActivities(room, member.ID)
	if err != nil || len(snapshot.Assets) != 1 {
		t.Fatalf("asset read: %+v %v", snapshot, err)
	}
	asset := snapshot.Assets[0]
	nonce, err := randomAttachmentID()
	if err != nil {
		t.Fatal(err)
	}
	sent, created, err := s.SendStickerMessage(room, member.ID, asset.ID, nonce)
	if err != nil || !created || len(sent.Attachments) != 1 || sent.Attachments[0].ID != stickerID {
		t.Fatalf("sticker send: %+v %v %v", sent, created, err)
	}
	retry, created, err := s.SendStickerMessage(room, member.ID, asset.ID, nonce)
	if err != nil || created || retry.ID != sent.ID {
		t.Fatalf("sticker retry duplicated: %+v %v %v", retry, created, err)
	}
	if _, _, err = s.AttachmentForMember(room, member.ID, stickerID); err != nil {
		t.Fatalf("asset attachment unavailable: %v", err)
	}
	if _, _, err = s.SendStickerMessage(room, outsider.ID, asset.ID, nonce); !errors.Is(err, ErrForbidden) {
		t.Fatalf("outsider sent sticker: %v", err)
	}
	videoID, err := randomAttachmentID()
	if err != nil {
		t.Fatal(err)
	}
	video := MessageAttachment{ID: videoID, Filename: "match.mp4", ContentType: "video/mp4", SizeBytes: 100}
	if err = s.SavePendingAttachment(room, owner.ID, "activities/test/"+videoID, video); err != nil {
		t.Fatal(err)
	}
	if err = s.CompletePendingAttachment(videoID, room); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.SendMessage(room, owner.ID, "A match", "", "", []string{videoID}); err != nil {
		t.Fatal(err)
	}
	state, err := s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "start", AttachmentID: videoID})
	if err != nil || state == nil || state.Revision != 1 || !state.Paused {
		t.Fatalf("watch start: %+v %v", state, err)
	}
	if _, err = s.ChangeWatchTogether(room, member.ID, WatchTogetherCommand{Action: "play", Revision: state.Revision}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer changed playback: %v", err)
	}
	state, err = s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "play", PositionSeconds: 12, Revision: state.Revision})
	if err != nil || state.Paused || state.Revision != 2 || state.PositionSeconds != 12 {
		t.Fatalf("watch play: %+v %v", state, err)
	}
	if _, err = s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "seek", PositionSeconds: 1, Revision: 1}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale seek accepted: %v", err)
	}
	state, err = s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "transfer", HostID: member.ID, Revision: state.Revision})
	if err != nil || state.HostID == nil || *state.HostID != member.ID {
		t.Fatalf("host transfer: %+v %v", state, err)
	}
	if _, err = s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "claim", Revision: state.Revision}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("live host stolen: %v", err)
	}
	if err = s.SetChannelAccess(c.ID, room, owner.ID, ChannelAccess{Overrides: []ChannelOverride{{SubjectKey: "member", Permissions: map[string]string{"join_voice": "deny"}}}}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.RoomForMember(room, member.ID); err != nil {
		t.Fatalf("voice-only revocation also hid read access: %v", err)
	}
	snapshot, err = s.ChannelActivities(room, owner.ID)
	if err != nil || snapshot.Watch == nil || !snapshot.Watch.CanClaim {
		t.Fatalf("revoked voice host not immediately claimable: %+v %v", snapshot.Watch, err)
	}
	if _, err = s.ChangeWatchTogether(room, member.ID, WatchTogetherCommand{Action: "heartbeat", Revision: state.Revision}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked voice host kept its lease: %v", err)
	}
	state, err = s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "claim", Revision: state.Revision})
	if err != nil {
		t.Fatalf("voice-only revocation blocked immediate handoff: %v", err)
	}
	if err = s.SetChannelAccess(c.ID, room, owner.ID, ChannelAccess{}); err != nil {
		t.Fatal(err)
	}
	state, err = s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "transfer", HostID: member.ID, Revision: state.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.RemoveCommunityMember(c.ID, owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	state, err = s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "claim", Revision: state.Revision})
	if err != nil || state.HostID == nil || *state.HostID != owner.ID {
		t.Fatalf("revoked host handoff: %+v %v", state, err)
	}
	if err = s.DeleteChannelMediaAsset(room, owner.ID, asset.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.AttachmentForMember(room, owner.ID, stickerID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed asset still downloadable: %v", err)
	}
}
