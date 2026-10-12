package api

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDailyReviewEmptyTimezoneRejected(t *testing.T) {
	in := QuietHoursInput{Enabled: true, Timezone: "", Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, StartTime: "22:00", EndTime: "08:00"}
	if validQuietHours(in) {
		t.Fatal("empty zone is accepted by Go but rejected by PostgreSQL AT TIME ZONE")
	}
}

func TestDailyReviewFirstSendCreatesDraftTombstoneIntegration(t *testing.T) {
	s, _, _, member, _, room := comfortFixture(t)
	ctx := context.Background()
	initial, err := s.TextDraft(ctx, member.ID, room.ID, "")
	if err != nil || initial.Version != 0 {
		t.Fatalf("unexpected initial draft %+v %v", initial, err)
	}
	if _, _, err = s.SendMessageWithDraft(room.ID, member.ID, "Sent before draft debounce", "", comfortUUID(t), nil, "", DraftSendClear{Version: 0, MutationID: comfortUUID(t)}); err != nil {
		t.Fatal(err)
	}
	current, err := s.TextDraft(ctx, member.ID, room.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := s.PutTextDraft(ctx, member.ID, room.ID, "", TextDraftInput{Body: "Sent before draft debounce", ExpectedVersion: initial.Version, MutationID: comfortUUID(t)})
	if current.Version == 0 || current.Body != "" || !errors.Is(writeErr, ErrConflict) {
		t.Fatalf("first send left draft version %d; stale version-zero writer returned %v instead of conflict", current.Version, writeErr)
	}
}

func TestDailyReviewEmptyTimezoneCannotBreakPeerMessageIntegration(t *testing.T) {
	s, _, owner, member, _, room := comfortFixture(t)
	ctx := context.Background()
	if _, err := s.DB.Exec(ctx, `INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,$2,'synthetic-key','synthetic-auth')`, member.ID, "https://fcm.googleapis.com/daily-review/"+comfortUUID(t)); err != nil {
		t.Fatal(err)
	}
	_, err := s.SetQuietHours(ctx, member.ID, QuietHoursInput{Enabled: true, Timezone: "", Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, StartTime: "22:00", EndTime: "08:00"}, time.Now())
	_, _, peerErr := s.SendMessage(room.ID, owner.ID, "Ordinary peer message", "", comfortUUID(t), nil)
	if !errors.Is(err, ErrForbidden) || peerErr != nil {
		t.Fatalf("empty zone save err=%v, peer message err=%v", err, peerErr)
	}
}

func TestDailyReviewQuietDevicesCannotStarveAwakePushTargetIntegration(t *testing.T) {
	s, a, owner, member, _, room := comfortFixture(t)
	ctx := context.Background()
	quiet, awake := owner, member
	if quiet.ID > awake.ID {
		quiet, awake = awake, quiet
	}
	m := comfortMessage(t, s, room.ID, owner.ID, "Background reminder target fairness")
	for _, user := range []User{quiet, awake} {
		if _, err := s.SetPersonalReminder(ctx, user.ID, room.ID, m.ID, time.Now().Add(time.Hour), comfortUUID(t)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.DB.Exec(ctx, `UPDATE personal_message_reminders SET due_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	addDevice := func(user string) ReminderDeviceInput {
		t.Helper()
		device := comfortDevice(t, s, user, false)
		if _, err := s.DB.Exec(ctx, `INSERT INTO push_subscriptions(user_id,device_id,endpoint,p256dh,auth) VALUES($1,$2,$3,'synthetic-key','synthetic-auth')`, user, device.DeviceID, "https://127.0.0.1/synthetic-invalid-endpoint/"+device.DeviceID); err != nil {
			t.Fatal(err)
		}
		return device
	}
	for i := 0; i < 20; i++ {
		addDevice(quiet.ID)
	}
	awakeDevice := addDevice(awake.ID)
	if _, err := s.DB.Exec(ctx, `UPDATE reminder_attention_devices SET last_seen_at=clock_timestamp()-interval '46 seconds'`); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPresence(quiet.ID, "dnd"); err != nil {
		t.Fatal(err)
	}
	// Invalid synthetic endpoints guarantee no external network request. The
	// dispatch must still reach the awake account and acquire/release its lease.
	a.Config.VAPIDPublicKey = "synthetic"
	a.Config.VAPIDPrivateKey = "synthetic"
	a.Config.VAPIDSubject = "mailto:test@example.test"
	for i := 0; i < 2; i++ {
		if _, err := a.DispatchDailyComfort(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := a.DispatchReminderPush(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var attempts int
	if err := s.DB.QueryRow(ctx, `SELECT COALESCE(sum(attempts),0) FROM reminder_attention_deliveries WHERE user_id=$1 AND device_id=$2`, awake.ID, awakeDevice.DeviceID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts == 0 {
		t.Fatal("twenty DND devices consumed every dispatch target slot; awake account never reached")
	}
}

func TestDailyReviewHalfHourDSTMatchesSQLIntegration(t *testing.T) {
	s, _, _, member, _, _ := comfortFixture(t)
	ctx := context.Background()
	cases := []struct {
		start, end, instant string
		active              bool
		version             int64
	}{
		{"00:00", "01:45", "2026-04-04T14:50:00Z", true, 0},
		{"00:00", "01:45", "2026-04-04T15:15:00Z", false, 1},
		{"01:00", "02:15", "2026-10-03T15:29:00Z", true, 2},
		{"01:00", "02:15", "2026-10-03T15:30:00Z", false, 3},
	}
	for _, c := range cases {
		instant, err := time.Parse(time.RFC3339, c.instant)
		if err != nil {
			t.Fatal(err)
		}
		q, err := s.SetQuietHours(ctx, member.ID, QuietHoursInput{Enabled: true, Timezone: "Australia/Lord_Howe", Weekdays: []int{0}, StartTime: c.start, EndTime: c.end, ExpectedVersion: c.version}, instant)
		if err != nil {
			t.Fatal(err)
		}
		goActive, _ := quietHoursAt(q, instant)
		var sqlActive bool
		if err = s.DB.QueryRow(ctx, `SELECT daily_quiet_active($1,$2)`, member.ID, instant).Scan(&sqlActive); err != nil {
			t.Fatal(err)
		}
		if goActive != c.active || sqlActive != c.active {
			t.Fatalf("half-hour transition at%s expected=%v Go=%v SQL=%v", c.instant, c.active, goActive, sqlActive)
		}
	}
}
