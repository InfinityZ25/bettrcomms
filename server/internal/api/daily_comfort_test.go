package api

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"
)

func comfortFixture(t *testing.T) (*PostgresStore, *API, User, User, User, Room) {
	t.Helper()
	s := conversationTestStore(t)
	users := socialUsers(t, s, 3)
	socialFriend(t, s, users[0].ID, users[1].ID)
	room, e := s.CreateRoom(users[0].ID, "Daily comfort")
	if e != nil {
		t.Fatal(e)
	}
	if e = s.AddRoomMember(room.ID, users[0].ID, users[1].ID); e != nil {
		t.Fatal(e)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173", DevAuth: true})
	return s, a, users[0], users[1], users[2], room
}

func TestDailyComfortCanonicalRoutesAndMigrationReplayIntegration(t *testing.T) {
	s, a, owner, member, outsider, room := comfortFixture(t)
	ctx := context.Background()
	m := comfortMessage(t, s, room.ID, owner.ID, "Canonical saved source")
	dailyJSON(t, a, member, "PUT", "me/saved-items", map[string]any{"message_id": m.ID}, 200)
	raw := dailyJSON(t, a, member, "GET", "me/saved-items", nil, 200)
	var page PersonalSavedPage
	if e := json.Unmarshal(raw, &page); e != nil || len(page.Items) != 1 {
		t.Fatalf("canonical save %s %v", raw, e)
	}
	dailyJSON(t, a, outsider, "DELETE", "me/saved-items/"+page.Items[0].ID, nil, 200)
	retained, _ := s.PersonalSavedItems(ctx, member.ID, "all", "", 10)
	if len(retained.Items) != 1 {
		t.Fatal("another account deleted a saved reference")
	}
	mutation := comfortUUID(t)
	due := time.Now().Add(time.Hour).UTC().Truncate(time.Millisecond)
	raw = dailyJSON(t, a, member, "POST", "me/message-reminders", map[string]any{"room_id": room.ID, "message_id": m.ID, "due_at": due, "mutation_id": mutation}, 200)
	var reminder PersonalReminder
	if e := json.Unmarshal(raw, &reminder); e != nil || reminder.ID == "" {
		t.Fatalf("canonical reminder %s %v", raw, e)
	}
	dailyJSON(t, a, outsider, "GET", "me/message-reminders/"+reminder.ID, nil, 404)
	dailyJSON(t, a, member, "GET", "me/message-reminders/"+reminder.ID, nil, 200)
	dailyJSON(t, a, member, "PATCH", "me/message-reminders/"+reminder.ID, map[string]any{"due_at": due.Add(time.Hour), "mutation_id": comfortUUID(t)}, 200)
	raw = dailyJSON(t, a, member, "GET", "me/reminders", nil, 200)
	var combined CombinedPersonalReminderPage
	if e := json.Unmarshal(raw, &combined); e != nil || len(combined.Reminders) != 1 {
		t.Fatalf("combined route %s %v", raw, e)
	}
	dailyJSON(t, a, member, "PATCH", "me/notification-settings", map[string]any{"expected_version": 0, "enabled": true, "timezone": "America/Mexico_City"}, 200)
	dailyJSON(t, a, member, "GET", "me/notification-settings", nil, 200)
	in := TextDraftInput{Body: "Retain migration text", MutationID: comfortUUID(t)}
	if _, e := s.PutTextDraft(ctx, member.ID, room.ID, "", in); e != nil {
		t.Fatal(e)
	}
	migration, e := os.ReadFile("../../migrations/020_daily_comfort.sql")
	if e != nil {
		t.Fatal(e)
	}
	for range 2 {
		if _, e = s.DB.Exec(ctx, string(migration)); e != nil {
			t.Fatalf("repeat migration: %v", e)
		}
	}
	draft, e := s.TextDraft(ctx, member.ID, room.ID, "")
	if e != nil || draft.Body != in.Body || draft.Version != 1 {
		t.Fatalf("migration reset draft %+v %v", draft, e)
	}
	q, e := s.QuietHours(ctx, member.ID, time.Now())
	if e != nil || q.Version != 1 || q.Timezone != "America/Mexico_City" || !q.Enabled {
		t.Fatal("migration reset configured quiet policy")
	}
	dailyJSON(t, a, member, "DELETE", "me/message-reminders/"+reminder.ID, nil, 200)
	dailyJSON(t, a, member, "DELETE", "me/saved-items/"+page.Items[0].ID, nil, 200)
}

func TestDailyComfortAccountCleanupAndWorkerLockOrderIntegration(t *testing.T) {
	s, a, owner, member, _, room := comfortFixture(t)
	ctx := context.Background()
	m := comfortMessage(t, s, room.ID, owner.ID, "Account cleanup source")
	if e := s.SetPersonalSavedItem(ctx, member.ID, "message", m.ID, true); e != nil {
		t.Fatal(e)
	}
	if _, e := s.PutTextDraft(ctx, member.ID, room.ID, "", TextDraftInput{Body: "Account private text", MutationID: comfortUUID(t)}); e != nil {
		t.Fatal(e)
	}
	reminder, e := s.SetPersonalReminder(ctx, member.ID, room.ID, m.ID, time.Now().Add(time.Hour), comfortUUID(t))
	if e != nil {
		t.Fatal(e)
	}
	device := comfortDevice(t, s, member.ID, false)
	if _, e = s.DB.Exec(ctx, `UPDATE personal_message_reminders SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1`, reminder.ID); e != nil {
		t.Fatal(e)
	}
	// Simulate the first lock of account deletion. Maintenance must skip the
	// account before owning its reminder; the deleter can continue without a cycle.
	blocker, e := s.DB.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer blocker.Rollback(ctx)
	if _, e = blocker.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, member.ID); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() {
		bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		_, e := s.MaterializeDailyReminders(bounded)
		done <- e
	}()
	select {
	case e = <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("worker waited behind account deletion after acquiring dependent rows")
	}
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if _, e = blocker.Exec(bounded, `SELECT id FROM personal_message_reminders WHERE id=$1 FOR UPDATE`, reminder.ID); e != nil {
		t.Fatalf("account/reminder lock cycle: %v", e)
	}
	if e = blocker.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	// A source-room deletion locks its room before cascading into reminders.
	blocker, e = s.DB.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer blocker.Rollback(ctx)
	if _, e = blocker.Exec(ctx, `SELECT id FROM rooms WHERE id=$1 FOR UPDATE`, room.ID); e != nil {
		t.Fatal(e)
	}
	var blockerPID int
	if e = blocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); e != nil {
		t.Fatal(e)
	}
	go func() {
		bounded, cancel := context.WithTimeout(ctx, 4*time.Second)
		defer cancel()
		_, e := s.MaterializeDailyReminders(bounded)
		done <- e
	}()
	waitUntil := time.Now().Add(3 * time.Second)
	for {
		var waiting bool
		if e = s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blockerPID).Scan(&waiting); e != nil {
			t.Fatal(e)
		}
		if waiting {
			break
		}
		if time.Now().After(waitUntil) {
			t.Fatal("worker did not reach the held source-room lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	bounded2, cancel2 := context.WithTimeout(ctx, 2*time.Second)
	defer cancel2()
	if _, e = blocker.Exec(bounded2, `SELECT id FROM personal_message_reminders WHERE id=$1 FOR UPDATE`, reminder.ID); e != nil {
		t.Fatalf("worker owned reminder before source room: %v", e)
	}
	if e = blocker.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	select {
	case e = <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not resume after room lock release")
	}
	if _, e = a.DispatchDailyComfort(ctx); e != nil {
		t.Fatal(e)
	}
	claim, e := s.ClaimReminderAttention(ctx, member.ID, device.DeviceID, false)
	if e != nil || claim.Count != 1 {
		t.Fatalf("pre-cleanup attention %+v %v", claim, e)
	}
	if _, e = s.DeleteAccount(ctx, member.ID); e != nil {
		t.Fatal(e)
	}
	for _, table := range []string{"personal_saved_items", "personal_message_reminders", "personal_reminder_mutations", "account_text_drafts", "account_draft_settings", "account_quiet_hours", "reminder_attention", "reminder_attention_devices", "reminder_attention_deliveries"} {
		var count int
		if e = s.DB.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE user_id=$1`, member.ID).Scan(&count); e != nil || count != 0 {
			t.Fatalf("account private table %s retained %d: %v", table, count, e)
		}
	}
	if _, e = s.ClaimReminderAttention(ctx, member.ID, device.DeviceID, false); !errors.Is(e, ErrNotFound) {
		t.Fatalf("deleted account attention accepted: %v", e)
	}
}

func TestDailyComfortReminderOutOfOrderRetriesIntegration(t *testing.T) {
	s, _, owner, member, _, room := comfortFixture(t)
	ctx := context.Background()
	m := comfortMessage(t, s, room.ID, owner.ID, "Reminder intent generations")
	oldDue := time.Now().Add(time.Hour).UTC().Truncate(time.Microsecond)
	oldMutation := comfortUUID(t)
	first, e := s.SetPersonalReminder(ctx, member.ID, room.ID, m.ID, oldDue, oldMutation)
	if e != nil {
		t.Fatal(e)
	}
	newDue := oldDue.Add(2 * time.Hour)
	latest, e := s.SetPersonalReminder(ctx, member.ID, room.ID, m.ID, newDue, comfortUUID(t))
	if e != nil {
		t.Fatal(e)
	}
	lateRetry, e := s.SetPersonalReminder(ctx, member.ID, room.ID, m.ID, oldDue, oldMutation)
	if e != nil || lateRetry.ID != first.ID || lateRetry.Version != latest.Version || !lateRetry.DueAt.Equal(newDue) {
		t.Fatalf("old retry reversed snooze %+v %v", lateRetry, e)
	}
	if e = s.RemovePersonalReminder(ctx, member.ID, first.ID, "", ""); e != nil {
		t.Fatal(e)
	}
	if _, e = s.SetPersonalReminder(ctx, member.ID, room.ID, m.ID, oldDue, oldMutation); !errors.Is(e, ErrConflict) {
		t.Fatalf("old retry resurrected cancellation: %v", e)
	}
	fresh, e := s.SetPersonalReminder(ctx, member.ID, room.ID, m.ID, newDue, comfortUUID(t))
	if e != nil || fresh.ID == first.ID {
		t.Fatalf("explicit new reminder failed %+v %v", fresh, e)
	}
	if _, e = s.DeleteMessage(room.ID, owner.ID, m.ID); e != nil {
		t.Fatal(e)
	}
	var count int
	if e = s.DB.QueryRow(ctx, `SELECT count(*) FROM personal_reminder_mutations WHERE user_id=$1`, member.ID).Scan(&count); e != nil || count != 0 {
		t.Fatal("deleted source retained personal mutation receipts")
	}
}

func TestDailyComfortMessagePushPolicyIntegration(t *testing.T) {
	s, _, owner, member, _, room := comfortFixture(t)
	ctx := context.Background()
	var sub string
	if e := s.DB.QueryRow(ctx, `INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,'https://push.example.test/daily-comfort','fixture-public','fixture-auth') RETURNING id::text`, member.ID).Scan(&sub); e != nil {
		t.Fatal(e)
	}
	queued := func(m Message) int {
		t.Helper()
		var count int
		if e := s.DB.QueryRow(ctx, `SELECT count(*) FROM push_deliveries WHERE message_id=$1 AND subscription_id=$2`, m.ID, sub).Scan(&count); e != nil {
			t.Fatal(e)
		}
		return count
	}
	first := comfortMessage(t, s, room.ID, owner.ID, "Normally alerts")
	if queued(first) != 1 {
		t.Fatal("normal message delivery missing")
	}
	until := time.Now().Add(time.Hour)
	if e := s.SetTimedNotificationPreference(ctx, room.ID, member.ID, nil, &until, true); e != nil {
		t.Fatal(e)
	}
	muted := comfortMessage(t, s, room.ID, owner.ID, "Temporarily muted")
	if queued(muted) != 0 {
		t.Fatal("timed mute enqueued message attention")
	}
	if _, e := s.DB.Exec(ctx, `UPDATE room_notification_preferences SET muted_until=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND room_id=$2`, member.ID, room.ID); e != nil {
		t.Fatal(e)
	}
	resumed := comfortMessage(t, s, room.ID, owner.ID, "After mute")
	if queued(resumed) != 1 {
		t.Fatal("ordinary alerts did not resume")
	}
	originalPresence, e := s.Presence(member.ID)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now().UTC()
	q, e := s.SetQuietHours(ctx, member.ID, QuietHoursInput{Enabled: true, Timezone: "UTC", Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, StartTime: now.Add(-time.Hour).Format("15:04"), EndTime: now.Add(time.Hour).Format("15:04")}, now)
	if e != nil || !q.Active {
		t.Fatalf("quiet %+v %v", q, e)
	}
	quiet := comfortMessage(t, s, room.ID, owner.ID, "Quiet message")
	if queued(quiet) != 0 {
		t.Fatal("quiet message queued for later replay")
	}
	call, e := s.NotificationAttention(ctx, member.ID, room.ID, "call")
	if e != nil || call.Allowed {
		t.Fatal("quiet policy allowed call attention")
	}
	presence, e := s.Presence(member.ID)
	if e != nil || presence != originalPresence {
		t.Fatal("quiet changed account presence")
	}
	// The dispatch recheck drops pre-quiet ordinary alerts without network I/O.
	sent, e := s.DispatchPush(ctx, Config{VAPIDPublicKey: "fixture", VAPIDPrivateKey: "fixture", VAPIDSubject: "mailto:fixture@example.test"})
	if e != nil || sent != 0 || queued(first) != 0 || queued(resumed) != 0 {
		t.Fatalf("queued messages survived quiet dispatch sent=%d err=%v", sent, e)
	}
	attachment := MessageAttachment{ID: comfortUUID(t), Filename: "quiet-sticker.png", ContentType: "image/png", SizeBytes: 32}
	if e = s.SavePendingAttachment(room.ID, owner.ID, "fixtures/"+attachment.ID, attachment); e != nil {
		t.Fatal(e)
	}
	if e = s.CompletePendingAttachment(attachment.ID, room.ID); e != nil {
		t.Fatal(e)
	}
	if e = s.CreateChannelMediaAsset(room.ID, owner.ID, attachment.ID, "Quiet sticker", "sticker", nil); e != nil {
		t.Fatal(e)
	}
	var asset string
	if e = s.DB.QueryRow(ctx, `SELECT id::text FROM channel_media_assets WHERE attachment_id=$1`, attachment.ID).Scan(&asset); e != nil {
		t.Fatal(e)
	}
	sticker, _, e := s.SendStickerMessage(room.ID, owner.ID, asset, comfortUUID(t))
	if e != nil || queued(sticker) != 0 {
		t.Fatalf("sticker bypassed quiet %v", e)
	}
	_, e = s.SetQuietHours(ctx, member.ID, QuietHoursInput{ExpectedVersion: q.Version, Enabled: false, Timezone: q.Timezone, Weekdays: q.Weekdays, StartTime: q.StartTime, EndTime: q.EndTime}, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	if e = s.SetPresence(member.ID, "dnd"); e != nil {
		t.Fatal(e)
	}
	dnd := comfortMessage(t, s, room.ID, owner.ID, "Manual account DND")
	if queued(dnd) != 0 {
		t.Fatal("account DND bypassed")
	}
	if e = s.SetPresence(member.ID, originalPresence); e != nil {
		t.Fatal(e)
	}
	if e = s.SetNotificationPreference(room.ID, member.ID, "mentions"); e != nil {
		t.Fatal(e)
	}
	ordinary := comfortMessage(t, s, room.ID, owner.ID, "No mention")
	mention := comfortMessage(t, s, room.ID, owner.ID, "Hello <@"+member.ID+">")
	if queued(ordinary) != 0 || queued(mention) != 1 {
		t.Fatal("mentions mode changed when temporary mute expired")
	}
}
func comfortUUID(t *testing.T) string {
	t.Helper()
	id, e := randomAttachmentID()
	if e != nil {
		t.Fatal(e)
	}
	return id
}
func comfortMessage(t *testing.T, s *PostgresStore, room, user, body string) Message {
	t.Helper()
	m, _, e := s.SendMessage(room, user, body, "", comfortUUID(t), nil)
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func comfortDevice(t *testing.T, s *PostgresStore, user string, dnd bool) ReminderDeviceInput {
	t.Helper()
	ctx := context.Background()
	token := comfortUUID(t)
	if e := s.CreateDeviceSession(ctx, sessionHash(token), user, time.Now().Add(time.Hour), "Fixture device"); e != nil {
		t.Fatal(e)
	}
	session, e := s.ResolveSession(ctx, sessionHash(token), time.Now())
	if e != nil {
		t.Fatal(e)
	}
	in := ReminderDeviceInput{DeviceID: comfortUUID(t), Transport: "page", DND: dnd, Alerts: true}
	if e = s.RegisterReminderDevice(ctx, user, session.ID, in); e != nil {
		t.Fatal(e)
	}
	return in
}
func TestDailyComfortSavedReferencesIntegration(t *testing.T) {
	s, _, owner, member, outsider, room := comfortFixture(t)
	ctx := context.Background()
	m := comfortMessage(t, s, room.ID, owner.ID, "Original https://example.test/guide")
	if e := s.SetPersonalSavedItem(ctx, member.ID, "message", m.ID, true); e != nil {
		t.Fatal(e)
	}
	first, e := s.PersonalSavedItems(ctx, member.ID, "all", "", 1)
	if e != nil || len(first.Items) != 1 {
		t.Fatalf("saved %+v %v", first, e)
	}
	if e = s.SetPersonalSavedItem(ctx, member.ID, "message", m.ID, true); e != nil {
		t.Fatal(e)
	}
	again, _ := s.PersonalSavedItems(ctx, member.ID, "all", "", 10)
	if len(again.Items) != 1 || again.Items[0].ID != first.Items[0].ID || !again.Items[0].CreatedAt.Equal(first.Items[0].CreatedAt) {
		t.Fatal("retry changed stable reference")
	}
	if e = s.SetPersonalSavedItem(ctx, outsider.ID, "message", m.ID, true); !errors.Is(e, ErrForbidden) {
		t.Fatalf("outsider save: %v", e)
	}
	edited, e := s.WriteMessage(room.ID, owner.ID, m.ID, "Updated https://example.test/current", "")
	if e != nil {
		t.Fatal(e)
	}
	again, _ = s.PersonalSavedItems(ctx, member.ID, "link", "", 10)
	if len(again.Items) != 1 || again.Items[0].Message.Body != edited.Body {
		t.Fatal("saved item retained a stale text snapshot")
	}
	file := MessageAttachment{ID: comfortUUID(t), Filename: "reference.png", ContentType: "image/png", SizeBytes: 32}
	if e = s.SavePendingAttachment(room.ID, owner.ID, "fixtures/"+file.ID, file); e != nil {
		t.Fatal(e)
	}
	if e = s.CompletePendingAttachment(file.ID, room.ID); e != nil {
		t.Fatal(e)
	}
	posted, _, e := s.SendMessage(room.ID, owner.ID, "Published file", "", comfortUUID(t), []string{file.ID})
	if e != nil {
		t.Fatal(e)
	}
	if e = s.SetPersonalSavedItem(ctx, member.ID, "file", file.ID, true); e != nil {
		t.Fatal(e)
	}
	files, e := s.PersonalSavedItems(ctx, member.ID, "file", "", 10)
	if e != nil || len(files.Items) != 1 || files.Items[0].Message.ID != posted.ID || files.Items[0].Attachment.ID != file.ID {
		t.Fatalf("file source: %+v %v", files, e)
	}
	pending := MessageAttachment{ID: comfortUUID(t), Filename: "unsent.png", ContentType: "image/png", SizeBytes: 32}
	if e = s.SavePendingAttachment(room.ID, member.ID, "fixtures/"+pending.ID, pending); e != nil {
		t.Fatal(e)
	}
	if e = s.CompletePendingAttachment(pending.ID, room.ID); e != nil {
		t.Fatal(e)
	}
	if e = s.SetPersonalSavedItem(ctx, member.ID, "file", pending.ID, true); !errors.Is(e, ErrNotFound) {
		t.Fatalf("unpublished personal file accepted: %v", e)
	}
	if e = s.RemoveRoomMember(room.ID, owner.ID, member.ID); e != nil {
		t.Fatal(e)
	}
	hidden, e := s.PersonalSavedItems(ctx, member.ID, "all", "", 20)
	if e != nil || len(hidden.Items) != 0 {
		t.Fatalf("revoked saved references leaked: %+v %v", hidden, e)
	}
	var count int
	if e = s.DB.QueryRow(ctx, `SELECT count(*) FROM personal_saved_items WHERE user_id=$1`, member.ID).Scan(&count); e != nil || count != 2 {
		t.Fatal("access revocation destroyed restorable references")
	}
	if e = s.AddRoomMember(room.ID, owner.ID, member.ID); e != nil {
		t.Fatal(e)
	}
	restored, _ := s.PersonalSavedItems(ctx, member.ID, "all", "", 10)
	if len(restored.Items) != 2 {
		t.Fatal("restored access did not reveal current references")
	}
	// A self-contained page cursor survives deletion of its anchor reference.
	if _, e = s.DB.Exec(ctx, `UPDATE personal_saved_items SET created_at='2026-10-11T00:00:00Z' WHERE user_id=$1`, member.ID); e != nil {
		t.Fatal(e)
	}
	page, e := s.PersonalSavedItems(ctx, member.ID, "all", "", 1)
	if e != nil || page.NextCursor == "" {
		t.Fatalf("first page: %+v %v", page, e)
	}
	if _, e = s.DB.Exec(ctx, `DELETE FROM personal_saved_items WHERE id=$1`, page.Items[0].ID); e != nil {
		t.Fatal(e)
	}
	next, e := s.PersonalSavedItems(ctx, member.ID, "all", page.NextCursor, 1)
	if e != nil || len(next.Items) != 1 || next.Items[0].ID == page.Items[0].ID {
		t.Fatalf("deleted anchor pagination: %+v %v", next, e)
	}
	if _, e = s.DeleteMessage(room.ID, owner.ID, m.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.DeleteMessage(room.ID, owner.ID, posted.ID); e != nil {
		t.Fatal(e)
	}
	empty, e := s.PersonalSavedItems(ctx, member.ID, "all", "", 10)
	if e != nil || len(empty.Items) != 0 {
		t.Fatalf("deleted source retained: %+v %v", empty, e)
	}
}

func TestDailyComfortDraftCASAndSendIntegration(t *testing.T) {
	s, a, owner, member, outsider, room := comfortFixture(t)
	ctx := context.Background()
	quote := comfortMessage(t, s, room.ID, owner.ID, "Original quote")
	settings, e := s.DraftSettings(ctx, member.ID)
	if e != nil || !settings.Enabled || settings.Version != 0 {
		t.Fatalf("automatic default: %+v %v", settings, e)
	}
	in := TextDraftInput{Body: "Device A <@" + owner.ID + ">", ReplyToID: quote.ID, MutationID: comfortUUID(t)}
	draft, e := s.PutTextDraft(ctx, member.ID, room.ID, "", in)
	if e != nil || draft.Version != 1 || draft.ReplyToID == nil {
		t.Fatalf("first draft: %+v %v", draft, e)
	}
	repeat, e := s.PutTextDraft(ctx, member.ID, room.ID, "", in)
	if e != nil || repeat.Version != 1 {
		t.Fatal("write retry was not idempotent")
	}
	bad := in
	bad.Body = "reused mutation"
	if _, e = s.PutTextDraft(ctx, member.ID, room.ID, "", bad); !errors.Is(e, ErrConflict) {
		t.Fatalf("nonce content reuse: %v", e)
	}
	stale := TextDraftInput{Body: "Device B offline", MutationID: comfortUUID(t)}
	current, e := s.PutTextDraft(ctx, member.ID, room.ID, "", stale)
	if !errors.Is(e, ErrConflict) || current.Body != in.Body {
		t.Fatal("offline conflict silently replaced text")
	}
	if _, e = s.PutTextDraft(ctx, outsider.ID, room.ID, "", stale); !errors.Is(e, ErrForbidden) {
		t.Fatalf("outsider draft: %v", e)
	}
	nonce := comfortUUID(t)
	sent, published, e := s.SendMessageWithDraft(room.ID, member.ID, in.Body, in.ReplyToID, nonce, nil, "", DraftSendClear{Version: 1, MutationID: comfortUUID(t)})
	if e != nil || !published {
		t.Fatalf("send clear: %v", e)
	}
	cleared, e := s.TextDraft(ctx, member.ID, room.ID, "")
	if e != nil || cleared.Body != "" || cleared.Version != 2 {
		t.Fatalf("missing tombstone: %+v %v", cleared, e)
	}
	if _, e = s.PutTextDraft(ctx, member.ID, room.ID, "", stale); !errors.Is(e, ErrConflict) {
		t.Fatal("offline text resurrected a sent draft")
	}
	next := TextDraftInput{Body: "New remote typing", ExpectedVersion: 2, MutationID: comfortUUID(t)}
	remote, e := s.PutTextDraft(ctx, member.ID, room.ID, "", next)
	if e != nil {
		t.Fatal(e)
	}
	retried, repub, e := s.SendMessageWithDraft(room.ID, member.ID, in.Body, in.ReplyToID, nonce, nil, "", DraftSendClear{Version: 1, MutationID: comfortUUID(t)})
	if e != nil || repub || retried.ID != sent.ID {
		t.Fatalf("send retry: %v", e)
	}
	retained, _ := s.TextDraft(ctx, member.ID, room.ID, "")
	if retained.Body != remote.Body || retained.Version != remote.Version {
		t.Fatal("send retry erased newer typing")
	}
	if _, _, e = s.SendMessageWithDraft(room.ID, member.ID, "Older submitted text", "", comfortUUID(t), nil, "", DraftSendClear{Version: 2, MutationID: comfortUUID(t)}); e != nil {
		t.Fatal(e)
	}
	retained, _ = s.TextDraft(ctx, member.ID, room.ID, "")
	if retained.Body != remote.Body {
		t.Fatal("stale submitted revision cleared newer text")
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, body := range []string{"Concurrent one", "Concurrent two"} {
		wg.Add(1)
		go func(body string) {
			defer wg.Done()
			_, e := s.PutTextDraft(ctx, member.ID, room.ID, "", TextDraftInput{Body: body, ExpectedVersion: 3, MutationID: comfortUUID(t)})
			results <- e
		}(body)
	}
	wg.Wait()
	close(results)
	ok, conflict := 0, 0
	for e := range results {
		if e == nil {
			ok++
		} else if errors.Is(e, ErrConflict) {
			conflict++
		} else {
			t.Fatal(e)
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("CAS writers successes=%d conflicts=%d", ok, conflict)
	}
	root := comfortMessage(t, s, room.ID, owner.ID, "Thread root")
	if _, _, e = s.SendThreadMessage(room.ID, owner.ID, "Thread reply", "", comfortUUID(t), nil, root.ID); e != nil {
		t.Fatal(e)
	}
	td, e := s.PutTextDraft(ctx, member.ID, room.ID, root.ID, TextDraftInput{Body: "Thread draft", ReplyToID: root.ID, MutationID: comfortUUID(t)})
	if e != nil || td.ThreadRootID == nil || *td.ThreadRootID != root.ID {
		t.Fatalf("thread scope: %+v %v", td, e)
	}
	if _, e = s.DeleteMessage(room.ID, owner.ID, root.ID); e != nil {
		t.Fatal(e)
	}
	td, e = s.TextDraft(ctx, member.ID, room.ID, root.ID)
	if e != nil || td.Body != "Thread draft" || td.ReplyToID != nil || td.Version != 2 {
		t.Fatalf("deleted quote preserved content or broke surviving thread: %+v %v", td, e)
	}
	// Strict JSON keeps all attachment, edit and send-token state device-local.
	dailyJSON(t, a, member, "PUT", "rooms/"+room.ID+"/draft", map[string]any{"body": "forbidden file state", "expected_version": 4, "mutation_id": comfortUUID(t), "attachment_ids": []string{comfortUUID(t)}}, 400)
	raw := dailyJSON(t, a, member, "GET", "me/draft-settings", nil, 200)
	if !json.Valid(raw) {
		t.Fatal("draft settings alias")
	}
	if _, e = s.SetDraftSettings(ctx, member.ID, false, 0); e != nil {
		t.Fatal(e)
	}
	if _, e = s.PutTextDraft(ctx, member.ID, room.ID, "", TextDraftInput{Body: "Disabled write", ExpectedVersion: 4, MutationID: comfortUUID(t)}); !errors.Is(e, ErrDraftSyncDisabled) {
		t.Fatalf("disabled sync write: %v", e)
	}
	retained, _ = s.TextDraft(ctx, member.ID, room.ID, "")
	if retained.Version != 4 || retained.Body == "" {
		t.Fatal("disabling sync destroyed local/cloud text")
	}
}

func TestDailyComfortQuietDSTBoundaries(t *testing.T) {
	cases := []struct {
		name, zone, start, end, instant string
		days                            []int
		active                          bool
		until                           string
	}{
		{"overnight selected weekday", "America/New_York", "22:00", "08:00", "2026-10-13T05:00:00Z", []int{1}, true, "2026-10-13T12:00:00Z"},
		{"unselected next evening", "America/New_York", "22:00", "08:00", "2026-10-14T03:00:00Z", []int{1}, false, ""},
		{"spring missing end", "America/New_York", "01:00", "02:30", "2026-03-08T06:59:00Z", []int{0}, true, "2026-03-08T07:00:00Z"},
		{"spring first valid instant", "America/New_York", "01:00", "02:30", "2026-03-08T07:00:00Z", []int{0}, false, ""},
		{"repeated end first occurrence still quiet", "America/New_York", "00:00", "01:30", "2026-11-01T05:45:00Z", []int{0}, true, "2026-11-01T06:30:00Z"},
		{"repeated end latest occurrence", "America/New_York", "00:00", "01:30", "2026-11-01T06:30:00Z", []int{0}, false, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			now, _ := time.Parse(time.RFC3339, c.instant)
			q := QuietHours{Enabled: true, Timezone: c.zone, Weekdays: c.days, StartTime: c.start, EndTime: c.end}
			active, next := quietHoursAt(q, now)
			if active != c.active {
				t.Fatalf("active=%v expected%v", active, c.active)
			}
			if c.until != "" && (next == nil || next.Format(time.RFC3339) != c.until) {
				t.Fatalf("boundary=%v wanted%s", next, c.until)
			}
		})
	}
	for _, bad := range []QuietHoursInput{{Enabled: true, Timezone: "Local", Weekdays: []int{0}, StartTime: "22:00", EndTime: "08:00"}, {Timezone: "UTC", Weekdays: []int{1, 1}, StartTime: "22:00", EndTime: "08:00"}, {Timezone: "UTC", Weekdays: []int{1}, StartTime: "24:00", EndTime: "08:00"}} {
		if validQuietHours(bad) {
			t.Fatal("invalid timezone/day/time accepted")
		}
	}
}

func TestDailyComfortQuietSQLAndMuteCASIntegration(t *testing.T) {
	s, _, _, member, _, room := comfortFixture(t)
	ctx := context.Background()
	q, e := s.SetQuietHours(ctx, member.ID, QuietHoursInput{Enabled: true, Timezone: "America/New_York", Weekdays: []int{0}, StartTime: "00:00", EndTime: "01:30"}, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	for _, at := range []string{"2026-11-01T05:45:00Z", "2026-11-01T06:30:00Z"} {
		instant, _ := time.Parse(time.RFC3339, at)
		goActive, _ := quietHoursAt(q, instant)
		var sqlActive bool
		if e = s.DB.QueryRow(ctx, `SELECT daily_quiet_active($1,$2)`, member.ID, instant).Scan(&sqlActive); e != nil || sqlActive != goActive {
			t.Fatalf("Go/SQL repeated-end mismatch %s Go%v SQL%v: %v", at, goActive, sqlActive, e)
		}
	}
	_, e = s.SetQuietHours(ctx, member.ID, QuietHoursInput{ExpectedVersion: 1, Enabled: true, Timezone: "America/New_York", Weekdays: []int{0}, StartTime: "01:00", EndTime: "02:30"}, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	var before, after bool
	if e = s.DB.QueryRow(ctx, `SELECT daily_quiet_active($1,'2026-03-08T06:59:00Z'),daily_quiet_active($1,'2026-03-08T07:00:00Z')`, member.ID).Scan(&before, &after); e != nil || !before || after {
		t.Fatalf("SQL gap normalization %v %v: %v", before, after, e)
	}
	version := int64(0)
	until := time.Now().Add(time.Hour)
	if e = s.SetTimedNotificationPreference(ctx, room.ID, member.ID, nil, &until, true, &version); e != nil {
		t.Fatal(e)
	}
	mode := "mentions"
	if e = s.SetTimedNotificationPreference(ctx, room.ID, member.ID, &mode, nil, false, &version); !errors.Is(e, ErrConflict) {
		t.Fatalf("stale mute overwrite: %v", e)
	}
	version = 1
	if e = s.SetTimedNotificationPreference(ctx, room.ID, member.ID, &mode, nil, false, &version); e != nil {
		t.Fatal(e)
	}
	mutes, _ := s.TimedNotificationMutes(ctx, member.ID)
	if _, ok := mutes[room.ID]; !ok {
		t.Fatal("changing underlying mode erased temporary mute")
	}
	if _, e = s.DB.Exec(ctx, `UPDATE room_notification_preferences SET muted_until=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND room_id=$2`, member.ID, room.ID); e != nil {
		t.Fatal(e)
	}
	mutes, _ = s.TimedNotificationMutes(ctx, member.ID)
	modes, _ := s.NotificationPreferences(member.ID)
	if len(mutes) != 0 || modes[room.ID] != "mentions" {
		t.Fatal("expired mute failed to restore underlying preference")
	}
}

func TestDailyComfortReminderWorkerDeviceLeasesIntegration(t *testing.T) {
	s, a, owner, member, outsider, room := comfortFixture(t)
	ctx := context.Background()
	messages := []Message{comfortMessage(t, s, room.ID, owner.ID, "Remember one"), comfortMessage(t, s, room.ID, owner.ID, "Remember two")}
	for _, m := range messages {
		due := time.Now().Add(time.Hour)
		mutation := comfortUUID(t)
		first, e := s.SetPersonalReminder(ctx, member.ID, room.ID, m.ID, due, mutation)
		if e != nil {
			t.Fatal(e)
		}
		retry, e := s.SetPersonalReminder(ctx, member.ID, room.ID, m.ID, due, mutation)
		if e != nil || retry.ID != first.ID || retry.Version != 1 {
			t.Fatalf("reminder retry %+v %v", retry, e)
		}
	}
	d1 := comfortDevice(t, s, member.ID, false)
	d2 := comfortDevice(t, s, member.ID, true)
	now := time.Now().UTC()
	q, e := s.SetQuietHours(ctx, member.ID, QuietHoursInput{Enabled: true, Timezone: "UTC", Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, StartTime: now.Add(-time.Hour).Format("15:04"), EndTime: now.Add(time.Hour).Format("15:04")}, now)
	if e != nil || !q.Active {
		t.Fatalf("quiet fixture %+v %v", q, e)
	}
	if e = s.CreateScheduledEvent(room.ID, owner.ID, "Event reminder", "", time.Now().Add(5*time.Minute)); e != nil {
		t.Fatal(e)
	}
	var event string
	if e = s.DB.QueryRow(ctx, `SELECT id::text FROM channel_scheduled_events WHERE room_id=$1`, room.ID).Scan(&event); e != nil {
		t.Fatal(e)
	}
	if e = s.RSVPScheduledEvent(room.ID, member.ID, event, "going"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.DB.Exec(ctx, `UPDATE personal_message_reminders SET due_at=clock_timestamp()-interval '1 second' WHERE user_id=$1`, member.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = a.DispatchDailyComfort(ctx); e != nil {
		t.Fatal(e)
	}
	due, e := s.PersonalReminders(ctx, member.ID, "due", "", 20)
	if e != nil || len(due.Reminders) != 2 {
		t.Fatalf("VAPID-free quiet inbox %+v %v", due, e)
	}
	events, e := s.EventReminders(member.ID)
	if e != nil || len(events) != 1 {
		t.Fatalf("event materialization %+v %v", events, e)
	}
	suppressed, e := s.ClaimReminderAttention(ctx, member.ID, d1.DeviceID, false)
	if e != nil || suppressed.Count != 0 {
		t.Fatalf("quiet alert escaped %+v %v", suppressed, e)
	}
	if _, e = s.ClaimReminderAttention(ctx, outsider.ID, d1.DeviceID, false); !errors.Is(e, ErrForbidden) {
		t.Fatalf("foreign device claimed: %v", e)
	}
	q.Enabled = false
	_, e = s.SetQuietHours(ctx, member.ID, QuietHoursInput{ExpectedVersion: q.Version, Enabled: false, Timezone: q.Timezone, Weekdays: q.Weekdays, StartTime: q.StartTime, EndTime: q.EndTime}, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	mode := "mute"
	if e = s.SetNotificationPreference(room.ID, member.ID, mode); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	claims := make(chan ReminderAttentionClaim, 2)
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claim, e := s.ClaimReminderAttention(ctx, member.ID, d1.DeviceID, false)
			claims <- claim
			errs <- e
		}()
	}
	wg.Wait()
	close(claims)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	var delivered ReminderAttentionClaim
	positives := 0
	for c := range claims {
		if c.Count > 0 {
			positives++
			delivered = c
		}
	}
	if positives != 1 || delivered.Count != 3 {
		t.Fatalf("resume did not yield one combined summary: %d %+v", positives, delivered)
	}
	dnd, e := s.ClaimReminderAttention(ctx, member.ID, d2.DeviceID, false)
	if e != nil || dnd.Count != 0 {
		t.Fatal("device DND ignored")
	}
	if e = s.AcknowledgeReminderAttention(ctx, outsider.ID, d1.DeviceID, delivered.LeaseID); e != nil {
		t.Fatal(e)
	}
	var marked int
	if e = s.DB.QueryRow(ctx, `SELECT count(*) FROM reminder_attention_deliveries WHERE device_id=$1 AND delivered_at IS NOT NULL`, d1.DeviceID).Scan(&marked); e != nil || marked != 0 {
		t.Fatal("foreign ack changed deliveries")
	}
	if e = s.AcknowledgeReminderAttention(ctx, member.ID, d1.DeviceID, delivered.LeaseID); e != nil {
		t.Fatal(e)
	}
	again, e := s.ClaimReminderAttention(ctx, member.ID, d1.DeviceID, false)
	if e != nil || again.Count != 0 {
		t.Fatal("acknowledged summary replayed")
	}
	var session string
	if e = s.DB.QueryRow(ctx, `SELECT session_id::text FROM reminder_attention_devices WHERE user_id=$1 AND device_id=$2`, member.ID, d2.DeviceID).Scan(&session); e != nil {
		t.Fatal(e)
	}
	d2.DND = false
	if e = s.RegisterReminderDevice(ctx, member.ID, session, d2); e != nil {
		t.Fatal(e)
	}
	other, e := s.ClaimReminderAttention(ctx, member.ID, d2.DeviceID, false)
	if e != nil || other.Count != 3 {
		t.Fatalf("another device lost pending reminders %+v %v", other, e)
	}
	// Reprogramming invalidates the old generation, even when already leased.
	refreshed, e := s.SetPersonalReminder(ctx, member.ID, room.ID, messages[0].ID, time.Now().Add(time.Hour), comfortUUID(t))
	if e != nil || refreshed.Version != 2 {
		t.Fatalf("snooze %+v %v", refreshed, e)
	}
	if e = s.AcknowledgeReminderAttention(ctx, member.ID, d2.DeviceID, other.LeaseID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.DB.Exec(ctx, `UPDATE personal_message_reminders SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1`, refreshed.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = a.DispatchDailyComfort(ctx); e != nil {
		t.Fatal(e)
	}
	generation, e := s.ClaimReminderAttention(ctx, member.ID, d1.DeviceID, false)
	if e != nil || generation.Count != 1 {
		t.Fatalf("new generation suppressed or duplicated %+v %v", generation, e)
	}
	if e = s.RemovePersonalReminder(ctx, member.ID, refreshed.ID, "", ""); e != nil {
		t.Fatal(e)
	}
	if e = s.AcknowledgeReminderAttention(ctx, member.ID, d1.DeviceID, generation.LeaseID); e != nil {
		t.Fatal(e)
	}
	// Worker restarts do not create another event reminder or replay old attention.
	if _, e = a.DispatchDailyComfort(ctx); e != nil {
		t.Fatal(e)
	}
	var eventCount int
	if e = s.DB.QueryRow(ctx, `SELECT count(*) FROM channel_event_reminders WHERE event_id=$1 AND user_id=$2`, event, member.ID).Scan(&eventCount); e != nil || eventCount != 1 {
		t.Fatal("worker restart duplicated existing event reminder")
	}
	combined, e := s.CombinedPersonalReminders(ctx, member.ID, "", 1)
	if e != nil || len(combined.Reminders) != 1 || combined.NextCursor == "" {
		t.Fatalf("combined inbox %+v %v", combined, e)
	}
	second, e := s.CombinedPersonalReminders(ctx, member.ID, combined.NextCursor, 1)
	if e != nil || len(second.Reminders) != 1 || second.Reminders[0].ID == combined.Reminders[0].ID {
		t.Fatalf("combined next page %+v %v", second, e)
	}
}
