package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

const attentionJoins = ` FROM reminder_attention a JOIN users owner ON owner.id=a.user_id AND owner.deleted_at IS NULL
 LEFT JOIN personal_message_reminders p ON p.id=a.personal_id LEFT JOIN messages m ON m.id=p.message_id
 LEFT JOIN channel_event_reminders n ON n.id=a.event_reminder_id
 LEFT JOIN channel_scheduled_events e ON e.id=n.event_id
 LEFT JOIN channel_event_rsvps rsvp ON rsvp.event_id=e.id AND rsvp.user_id=a.user_id`
const attentionValid = `can_access_room(a.room_id,a.user_id) AND (
 (a.personal_id IS NOT NULL AND p.state='due' AND p.version=a.generation AND m.deleted_at IS NULL AND m.room_id=a.room_id)
 OR (a.event_reminder_id IS NOT NULL AND n.acknowledged_at IS NULL AND e.cancelled_at IS NULL AND e.room_id=a.room_id AND rsvp.response IN('going','maybe')))`

func (s *PostgresStore) RegisterReminderDevice(ctx context.Context, user, session string, in ReminderDeviceInput) error {
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var actor string
	if e = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, user).Scan(&actor); e != nil {
		return norm(e)
	}
	var found string
	if e = tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()`, session, user).Scan(&found); e != nil {
		return ErrForbidden
	}
	var exists bool
	var count int
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM reminder_attention_devices WHERE user_id=$1 AND device_id=$2),(SELECT count(*) FROM reminder_attention_devices WHERE user_id=$1)`, user, in.DeviceID).Scan(&exists, &count); e != nil {
		return e
	}
	if !exists && count >= 50 {
		return ErrPersonalLimit
	}
	_, e = tx.Exec(ctx, `INSERT INTO reminder_attention_devices(user_id,device_id,session_id,transport,dnd,alerts) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,device_id) DO UPDATE SET session_id=EXCLUDED.session_id,transport=EXCLUDED.transport,dnd=EXCLUDED.dnd,alerts=EXCLUDED.alerts,last_seen_at=clock_timestamp()`, user, in.DeviceID, session, in.Transport, in.DND, in.Alerts)
	if e != nil {
		return e
	}
	// A new device receives each currently outstanding reminder once.
	if e = materializeDeviceAttention(ctx, tx, user, in.DeviceID); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func materializeDeviceAttention(ctx context.Context, tx pgx.Tx, user, device string) error {
	_, e := tx.Exec(ctx, `INSERT INTO reminder_attention_deliveries(attention_id,user_id,device_id) SELECT a.id,a.user_id,$2`+attentionJoins+` WHERE a.user_id=$1 AND `+attentionValid+` ORDER BY a.created_at,a.id LIMIT 1000 ON CONFLICT DO NOTHING`, user, device)
	return e
}
func (s *PostgresStore) ClaimReminderAttention(ctx context.Context, user, device string, push bool) (ReminderAttentionClaim, error) {
	out := ReminderAttentionClaim{}
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	if e = lockPersonalActor(ctx, tx, user); e != nil {
		return out, e
	}
	var allowed bool
	var transport string
	var seen time.Time
	e = tx.QueryRow(ctx, `SELECT d.alerts AND NOT d.dnd AND daily_attention_allowed(d.user_id,clock_timestamp()) AND sess.expires_at>clock_timestamp(),d.transport,d.last_seen_at FROM reminder_attention_devices d JOIN sessions sess ON sess.id=d.session_id AND sess.user_id=d.user_id WHERE d.user_id=$1 AND d.device_id=$2 FOR UPDATE OF d`, user, device).Scan(&allowed, &transport, &seen)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, ErrForbidden
	}
	if e != nil {
		return out, e
	}
	if !allowed || push && (transport == "desktop" || seen.After(time.Now().Add(-45*time.Second))) {
		return out, tx.Commit(ctx)
	}
	if e = materializeDeviceAttention(ctx, tx, user, device); e != nil {
		return out, e
	}
	var leased bool
	e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM reminder_attention_deliveries WHERE user_id=$1 AND device_id=$2 AND delivered_at IS NULL AND lease_until>clock_timestamp())`, user, device).Scan(&leased)
	if e != nil {
		return out, e
	}
	if leased {
		return out, tx.Commit(ctx)
	}
	lease, e := randomAttachmentID()
	if e != nil {
		return out, e
	}
	rows, e := tx.Query(ctx, `WITH due AS (SELECT d.attention_id FROM reminder_attention_deliveries d JOIN reminder_attention a ON a.id=d.attention_id JOIN users owner ON owner.id=a.user_id AND owner.deleted_at IS NULL
 LEFT JOIN personal_message_reminders p ON p.id=a.personal_id LEFT JOIN messages m ON m.id=p.message_id
 LEFT JOIN channel_event_reminders n ON n.id=a.event_reminder_id LEFT JOIN channel_scheduled_events e ON e.id=n.event_id LEFT JOIN channel_event_rsvps rsvp ON rsvp.event_id=e.id AND rsvp.user_id=a.user_id
 WHERE d.user_id=$1 AND d.device_id=$2 AND d.delivered_at IS NULL AND d.next_attempt_at<=clock_timestamp() AND (d.lease_until IS NULL OR d.lease_until<=clock_timestamp()) AND `+attentionValid+`
 ORDER BY a.created_at,a.id LIMIT 1000 FOR UPDATE OF d)
 UPDATE reminder_attention_deliveries d SET lease_id=$3,lease_until=clock_timestamp()+interval '45 seconds',attempts=d.attempts+1
 FROM due WHERE d.attention_id=due.attention_id AND d.user_id=$1 AND d.device_id=$2 RETURNING d.lease_until`, user, device, lease)
	if e != nil {
		return out, e
	}
	var until time.Time
	for rows.Next() {
		if e = rows.Scan(&until); e != nil {
			break
		}
		out.Count++
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return out, e
	}
	if out.Count > 0 {
		out.LeaseID = lease
		out.Tag = "bettercomms-reminders:" + device
		out.ExpiresAt = &until
	}
	return out, tx.Commit(ctx)
}
func (s *PostgresStore) AcknowledgeReminderAttention(ctx context.Context, user, device, lease string) error {
	_, e := s.DB.Exec(ctx, `UPDATE reminder_attention_deliveries SET delivered_at=clock_timestamp(),lease_until=NULL WHERE user_id=$1 AND device_id=$2 AND lease_id=$3 AND delivered_at IS NULL AND lease_until>clock_timestamp()`, user, device, lease)
	return e
}
func (s *PostgresStore) releaseReminderAttention(ctx context.Context, user, device, lease string) error {
	_, e := s.DB.Exec(ctx, `UPDATE reminder_attention_deliveries SET lease_until=NULL,lease_id=NULL,next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(3600,POWER(2,LEAST(attempts,10))::integer)) WHERE user_id=$1 AND device_id=$2 AND lease_id=$3 AND delivered_at IS NULL`, user, device, lease)
	return e
}

// Materialization never depends on external notification credentials. Due rows
// remain readable during quiet time, reconnect and push-service failures.
func (s *PostgresStore) MaterializeDailyReminders(ctx context.Context) ([]string, error) {
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	changed := map[string]bool{}
	// Claim live accounts before reminder/FK locks. Account deletion owns the
	// user first, so acquiring it after a reminder would create a lock cycle.
	actors, e := tx.Query(ctx, `SELECT u.id::text FROM users u WHERE u.deleted_at IS NULL AND (
 EXISTS(SELECT 1 FROM personal_message_reminders p JOIN messages m ON m.id=p.message_id WHERE p.user_id=u.id AND m.deleted_at IS NULL AND can_access_room(m.room_id,u.id) AND ((p.state='pending' AND p.due_at<=clock_timestamp()) OR (p.state='due' AND NOT EXISTS(SELECT 1 FROM reminder_attention a WHERE a.personal_id=p.id AND a.generation=p.version))))
 OR EXISTS(SELECT 1 FROM channel_scheduled_events e JOIN channel_event_rsvps v ON v.event_id=e.id WHERE v.user_id=u.id AND v.response IN('going','maybe') AND e.cancelled_at IS NULL AND e.starts_at<=clock_timestamp()+interval '10 minutes' AND e.starts_at>clock_timestamp()-interval '1 day' AND can_access_room(e.room_id,u.id) AND NOT EXISTS(SELECT 1 FROM channel_event_reminders n WHERE n.event_id=e.id AND n.user_id=u.id))
 OR EXISTS(SELECT 1 FROM channel_event_reminders n JOIN channel_scheduled_events e ON e.id=n.event_id JOIN channel_event_rsvps v ON v.event_id=e.id AND v.user_id=n.user_id WHERE n.user_id=u.id AND n.acknowledged_at IS NULL AND e.cancelled_at IS NULL AND v.response IN('going','maybe') AND can_access_room(e.room_id,u.id) AND NOT EXISTS(SELECT 1 FROM reminder_attention a WHERE a.event_reminder_id=n.id))
 OR EXISTS(SELECT 1 FROM reminder_attention a WHERE a.user_id=u.id AND (EXISTS(SELECT 1 FROM reminder_attention_devices device JOIN sessions sess ON sess.id=device.session_id AND sess.expires_at>clock_timestamp() WHERE device.user_id=a.user_id AND NOT EXISTS(SELECT 1 FROM reminder_attention_deliveries d WHERE d.attention_id=a.id AND d.user_id=a.user_id AND d.device_id=device.device_id)) OR (a.personal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM personal_message_reminders p WHERE p.id=a.personal_id AND p.version=a.generation)) OR (a.event_reminder_id IS NOT NULL AND EXISTS(SELECT 1 FROM channel_event_reminders n JOIN channel_scheduled_events e ON e.id=n.event_id LEFT JOIN channel_event_rsvps v ON v.event_id=e.id AND v.user_id=n.user_id WHERE n.id=a.event_reminder_id AND (n.acknowledged_at IS NOT NULL OR e.cancelled_at IS NOT NULL OR v.response IS NULL OR v.response NOT IN('going','maybe'))))))) ORDER BY u.id LIMIT 200 FOR KEY SHARE OF u SKIP LOCKED`)
	if e != nil {
		return nil, e
	}
	users := []string{}
	for actors.Next() {
		var user string
		if e = actors.Scan(&user); e != nil {
			break
		}
		users = append(users, user)
	}
	if e == nil {
		e = actors.Err()
	}
	actors.Close()
	if e != nil {
		return nil, e
	}
	if len(users) == 0 {
		return []string{}, tx.Commit(ctx)
	}
	roomRows, e := tx.Query(ctx, `SELECT DISTINCT room FROM (SELECT m.room_id room FROM personal_message_reminders p JOIN messages m ON m.id=p.message_id WHERE p.user_id=ANY($1::uuid[]) UNION SELECT e.room_id FROM channel_event_reminders n JOIN channel_scheduled_events e ON e.id=n.event_id WHERE n.user_id=ANY($1::uuid[]) UNION SELECT e.room_id FROM channel_scheduled_events e JOIN channel_event_rsvps v ON v.event_id=e.id WHERE v.user_id=ANY($1::uuid[]) UNION SELECT room_id FROM reminder_attention WHERE user_id=ANY($1::uuid[])) sources ORDER BY room`, users)
	if e != nil {
		return nil, e
	}
	rooms := []string{}
	for roomRows.Next() {
		var room string
		if e = roomRows.Scan(&room); e != nil {
			break
		}
		rooms = append(rooms, room)
	}
	if e == nil {
		e = roomRows.Err()
	}
	roomRows.Close()
	if e != nil {
		return nil, e
	}
	for _, room := range rooms {
		if e = lockRoomCommunity(ctx, tx, room); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))`, room); e != nil {
			return nil, e
		}
		var found string
		if e = tx.QueryRow(ctx, `SELECT id::text FROM rooms WHERE id=$1 FOR KEY SHARE`, room).Scan(&found); e != nil {
			return nil, norm(e)
		}
	}
	collect := func(sql string) error {
		rows, err := tx.Query(ctx, sql, users)
		if err != nil {
			return err
		}
		for rows.Next() {
			var user string
			if err = rows.Scan(&user); err != nil {
				break
			}
			changed[user] = true
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		return err
	}
	e = collect(`WITH due AS (SELECT p.id FROM personal_message_reminders p JOIN messages m ON m.id=p.message_id JOIN users u ON u.id=p.user_id AND u.deleted_at IS NULL WHERE p.user_id=ANY($1::uuid[]) AND p.state='pending' AND p.due_at<=clock_timestamp() AND m.deleted_at IS NULL AND can_access_room(m.room_id,p.user_id) ORDER BY p.due_at,p.id LIMIT 200 FOR UPDATE OF p SKIP LOCKED) UPDATE personal_message_reminders p SET state='due' FROM due WHERE p.id=due.id RETURNING p.user_id::text`)
	if e != nil {
		return nil, e
	}
	e = collect(`INSERT INTO channel_event_reminders(event_id,user_id) SELECT e.id,r.user_id FROM channel_scheduled_events e JOIN channel_event_rsvps r ON r.event_id=e.id JOIN users u ON u.id=r.user_id AND u.deleted_at IS NULL WHERE r.user_id=ANY($1::uuid[]) AND e.cancelled_at IS NULL AND r.response IN('going','maybe') AND e.starts_at<=clock_timestamp()+interval '10 minutes' AND e.starts_at>clock_timestamp()-interval '1 day' AND can_access_room(e.room_id,r.user_id) AND NOT EXISTS(SELECT 1 FROM channel_event_reminders n WHERE n.event_id=e.id AND n.user_id=r.user_id) ORDER BY e.starts_at,e.id,r.user_id LIMIT 200 ON CONFLICT DO NOTHING RETURNING user_id::text`)
	if e != nil {
		return nil, e
	}
	// Invalidated generations disappear with their queued device attention.
	_, e = tx.Exec(ctx, `DELETE FROM reminder_attention a WHERE a.user_id=ANY($1::uuid[]) AND ((a.personal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM personal_message_reminders p WHERE p.id=a.personal_id AND p.state='due' AND p.version=a.generation)) OR (a.event_reminder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM channel_event_reminders n JOIN channel_scheduled_events e ON e.id=n.event_id JOIN channel_event_rsvps v ON v.event_id=e.id AND v.user_id=n.user_id WHERE n.id=a.event_reminder_id AND n.acknowledged_at IS NULL AND e.cancelled_at IS NULL AND v.response IN('going','maybe')))) `, users)
	if e != nil {
		return nil, e
	}
	e = collect(`INSERT INTO reminder_attention(user_id,room_id,personal_id,generation) SELECT p.user_id,m.room_id,p.id,p.version FROM personal_message_reminders p JOIN messages m ON m.id=p.message_id JOIN users u ON u.id=p.user_id AND u.deleted_at IS NULL WHERE p.user_id=ANY($1::uuid[]) AND p.state='due' AND m.deleted_at IS NULL AND can_access_room(m.room_id,p.user_id) AND NOT EXISTS(SELECT 1 FROM reminder_attention a WHERE a.personal_id=p.id AND a.generation=p.version) ORDER BY p.due_at,p.id LIMIT 200 ON CONFLICT DO NOTHING RETURNING user_id::text`)
	if e != nil {
		return nil, e
	}
	e = collect(`INSERT INTO reminder_attention(user_id,room_id,event_reminder_id) SELECT n.user_id,e.room_id,n.id FROM channel_event_reminders n JOIN channel_scheduled_events e ON e.id=n.event_id JOIN channel_event_rsvps v ON v.event_id=e.id AND v.user_id=n.user_id JOIN users u ON u.id=n.user_id AND u.deleted_at IS NULL WHERE n.user_id=ANY($1::uuid[]) AND n.acknowledged_at IS NULL AND e.cancelled_at IS NULL AND v.response IN('going','maybe') AND can_access_room(e.room_id,n.user_id) AND NOT EXISTS(SELECT 1 FROM reminder_attention a WHERE a.event_reminder_id=n.id) ORDER BY n.created_at,n.id LIMIT 200 ON CONFLICT DO NOTHING RETURNING user_id::text`)
	if e != nil {
		return nil, e
	}
	_, e = tx.Exec(ctx, `INSERT INTO reminder_attention_deliveries(attention_id,user_id,device_id) SELECT a.id,a.user_id,device.device_id`+attentionJoins+` JOIN reminder_attention_devices device ON device.user_id=a.user_id JOIN sessions sess ON sess.id=device.session_id AND sess.user_id=device.user_id AND sess.expires_at>clock_timestamp() WHERE a.user_id=ANY($1::uuid[]) AND `+attentionValid+` AND NOT EXISTS(SELECT 1 FROM reminder_attention_deliveries delivered WHERE delivered.attention_id=a.id AND delivered.user_id=a.user_id AND delivered.device_id=device.device_id) ORDER BY a.created_at,a.id LIMIT 500 ON CONFLICT DO NOTHING`, users)
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	out := []string{}
	for user := range changed {
		out = append(out, user)
	}
	return out, nil
}

// DispatchDailyComfort is the single ten-second maintenance entry point.
func (a *API) DispatchDailyComfort(ctx context.Context) (int, error) {
	s, ok := a.Store.(*PostgresStore)
	if !ok {
		return 0, nil
	}
	if !a.accessMu.TryRLock() {
		return 0, nil
	}
	users, e := s.MaterializeDailyReminders(ctx)
	if e == nil {
		for _, user := range users {
			a.publishPersonalInvalidation(user, "personal.reminders.changed")
		}
	}
	a.accessMu.RUnlock()
	if e != nil {
		return 0, e
	}
	return len(users), nil
}

// DispatchReminderPush runs independently of durable inbox materialization.
func (a *API) DispatchReminderPush(ctx context.Context) (int, error) {
	s, ok := a.Store.(*PostgresStore)
	if !ok {
		return 0, nil
	}
	if a.Config.VAPIDPublicKey == "" || a.Config.VAPIDPrivateKey == "" || a.Config.VAPIDSubject == "" {
		return 0, nil
	}
	rows, e := s.DB.Query(ctx, `SELECT DISTINCT d.user_id::text,d.device_id::text FROM reminder_attention_devices d
 JOIN sessions sess ON sess.id=d.session_id AND sess.user_id=d.user_id AND sess.expires_at>clock_timestamp()
 JOIN push_subscriptions ps ON ps.user_id=d.user_id AND ps.device_id=d.device_id AND NOT ps.dnd
 WHERE d.alerts AND NOT d.dnd AND d.transport='page' AND d.last_seen_at<clock_timestamp()-interval '45 seconds'
 AND daily_attention_allowed(d.user_id,clock_timestamp())
 AND EXISTS(SELECT 1`+attentionJoins+` JOIN reminder_attention_deliveries delivery ON delivery.attention_id=a.id
 WHERE delivery.user_id=d.user_id AND delivery.device_id=d.device_id AND delivery.delivered_at IS NULL AND delivery.next_attempt_at<=clock_timestamp()
 AND (delivery.lease_until IS NULL OR delivery.lease_until<=clock_timestamp()) AND `+attentionValid+`)
 ORDER BY 1,2 LIMIT 20`)
	if e != nil {
		return 0, e
	}
	var targets [][2]string
	for rows.Next() {
		var user, device string
		if e = rows.Scan(&user, &device); e != nil {
			break
		}
		targets = append(targets, [2]string{user, device})
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return 0, e
	}
	sent := 0
	for _, target := range targets {
		if ctx.Err() != nil {
			return sent, ctx.Err()
		}
		if !a.accessMu.TryRLock() {
			continue
		}
		claim, err := s.ClaimReminderAttention(ctx, target[0], target[1], true)
		if err != nil || claim.Count == 0 {
			a.accessMu.RUnlock()
			if err != nil && !errors.Is(err, ErrForbidden) {
				return sent, err
			}
			continue
		}
		var d pushDelivery
		var stillAllowed bool
		var count int
		err = s.DB.QueryRow(ctx, `SELECT ps.id::text,ps.endpoint,ps.p256dh,ps.auth,NOT ps.dnd AND daily_attention_allowed(ps.user_id,clock_timestamp()) FROM push_subscriptions ps WHERE ps.user_id=$1 AND ps.device_id=$2 ORDER BY ps.created_at DESC LIMIT 1`, target[0], target[1]).Scan(&d.SubscriptionID, &d.Endpoint, &d.P256dh, &d.Auth, &stillAllowed)
		if err == nil {
			err = s.DB.QueryRow(ctx, `SELECT count(*)`+attentionJoins+` JOIN reminder_attention_deliveries delivery ON delivery.attention_id=a.id WHERE delivery.user_id=$1 AND delivery.device_id=$2 AND delivery.lease_id=$3 AND delivery.delivered_at IS NULL AND `+attentionValid, target[0], target[1], claim.LeaseID).Scan(&count)
		}
		status := 0
		if err == nil && stillAllowed && count > 0 && validPushEndpoint(d.Endpoint) {
			payload, _ := json.Marshal(map[string]any{"kind": "reminder-summary", "title": "BetterComms reminders", "body": "You have reminders to review", "tag": claim.Tag, "count": count, "personalInbox": "reminders"})
			sendCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			status, err = sendWebPush(sendCtx, d, payload, a.Config)
			cancel()
		}
		if err == nil && status >= 200 && status < 300 {
			err = s.AcknowledgeReminderAttention(ctx, target[0], target[1], claim.LeaseID)
			sent++
		} else {
			if status == http.StatusGone || status == http.StatusNotFound {
				_, _ = s.DB.Exec(ctx, `DELETE FROM push_subscriptions WHERE id=$1 AND endpoint=$2`, d.SubscriptionID, d.Endpoint)
			}
			releaseErr := s.releaseReminderAttention(ctx, target[0], target[1], claim.LeaseID)
			// A provider failure retains the outbox for retry and must not expose
			// an endpoint-bearing HTTP error to maintenance logs or block devices.
			err = releaseErr
		}
		a.accessMu.RUnlock()
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return sent, err
		}
	}
	return sent, nil
}
