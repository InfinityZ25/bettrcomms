package api

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/jackc/pgx/v5"
)

func clockMinute(raw string) (int, bool) {
	if len(raw) != 5 || raw[2] != ':' {
		return 0, false
	}
	h, e := strconv.Atoi(raw[:2])
	m, f := strconv.Atoi(raw[3:])
	return h*60 + m, e == nil && f == nil && h >= 0 && h < 24 && m >= 0 && m < 60
}
func validQuietHours(in QuietHoursInput) bool {
	start, a := clockMinute(in.StartTime)
	end, b := clockMinute(in.EndTime)
	if !a || !b || start == end || in.ExpectedVersion < 0 || len(in.Weekdays) < 1 || len(in.Weekdays) > 7 || strings.TrimSpace(in.Timezone) == "" || len(in.Timezone) > 100 || in.Timezone == "Local" || strings.ContainsAny(in.Timezone, "\\\x00") {
		return false
	}
	if _, e := time.LoadLocation(in.Timezone); e != nil {
		return false
	}
	seen := map[int]bool{}
	for _, d := range in.Weekdays {
		if d < 0 || d > 6 || seen[d] {
			return false
		}
		seen[d] = true
	}
	return true
}

// Resolve wall-clock endpoints independently of the OS choice for an ambiguous
// local time. Endpoints repeated by DST use the latest occurrence; gaps use the
// first valid minute at or after the requested wall time.
func quietWallBoundary(day time.Time, minute int, loc *time.Location, last bool) time.Time {
	y, m, d := day.Date()
	candidate := time.Date(y, m, d, minute/60, minute%60, 0, 0, loc)
	_, before := candidate.Add(-3 * time.Hour).Zone()
	_, after := candidate.Add(3 * time.Hour).Zone()
	if before == after && candidate.Day() == d && candidate.Hour()*60+candidate.Minute() == minute {
		return candidate
	}
	var exact, later time.Time
	laterMinute := 1441
	for t := candidate.Add(-3 * time.Hour); !t.After(candidate.Add(3 * time.Hour)); t = t.Add(time.Minute) {
		local := t.In(loc)
		ly, lm, ld := local.Date()
		if ly != y || lm != m || ld != d {
			continue
		}
		value := local.Hour()*60 + local.Minute()
		if value == minute {
			if exact.IsZero() || last {
				exact = t
			}
		} else if value > minute && (value < laterMinute || value == laterMinute && later.IsZero()) {
			later = t
			laterMinute = value
		}
	}
	if !exact.IsZero() {
		return exact
	}
	if !later.IsZero() {
		return later
	}
	return candidate
}
func quietHoursAt(q QuietHours, now time.Time) (bool, *time.Time) {
	if !q.Enabled {
		return false, nil
	}
	loc, e := time.LoadLocation(q.Timezone)
	if e != nil {
		return false, nil
	}
	start, _ := clockMinute(q.StartTime)
	end, _ := clockMinute(q.EndTime)
	day := now.In(loc)
	y, m, d := day.Date()
	day = time.Date(y, m, d, 12, 0, 0, 0, loc)
	days := map[time.Weekday]bool{}
	for _, v := range q.Weekdays {
		days[time.Weekday(v)] = true
	}
	var next *time.Time
	for offset := -1; offset <= 7; offset++ {
		anchor := day.AddDate(0, 0, offset)
		if !days[anchor.Weekday()] {
			continue
		}
		from := quietWallBoundary(anchor, start, loc, false)
		endDay := anchor
		if start > end {
			endDay = anchor.AddDate(0, 0, 1)
		}
		to := quietWallBoundary(endDay, end, loc, true)
		if !now.Before(from) && now.Before(to) {
			v := to.UTC()
			return true, &v
		}
		if from.After(now) && (next == nil || from.Before(*next)) {
			v := from.UTC()
			next = &v
		}
	}
	return false, next
}
func (s *PostgresStore) QuietHours(ctx context.Context, user string, now time.Time) (QuietHours, error) {
	q := QuietHours{Timezone: "UTC", Weekdays: []int{0, 1, 2, 3, 4, 5, 6}, StartTime: "22:00", EndTime: "08:00", ServerTime: now.UTC()}
	var start, end int
	e := s.DB.QueryRow(ctx, `SELECT COALESCE(q.version,0),COALESCE(q.enabled,false),COALESCE(q.timezone,'UTC'),COALESCE(q.weekdays,ARRAY[0,1,2,3,4,5,6]),COALESCE(q.start_minute,1320),COALESCE(q.end_minute,480),u.presence_status='dnd' FROM users u LEFT JOIN account_quiet_hours q ON q.user_id=u.id WHERE u.id=$1 AND u.deleted_at IS NULL`, user).Scan(&q.Version, &q.Enabled, &q.Timezone, &q.Weekdays, &start, &end, &q.AccountDND)
	if e != nil {
		return q, norm(e)
	}
	q.StartTime = fmt.Sprintf("%02d:%02d", start/60, start%60)
	q.EndTime = fmt.Sprintf("%02d:%02d", end/60, end%60)
	q.Active, q.NextChangeAt = quietHoursAt(q, now)
	if q.Active {
		q.QuietUntil = q.NextChangeAt
	}
	return q, nil
}
func (s *PostgresStore) SetQuietHours(ctx context.Context, user string, in QuietHoursInput, now time.Time) (QuietHours, error) {
	if !validQuietHours(in) {
		return QuietHours{}, ErrForbidden
	}
	var knownZone bool
	if e := s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)`, in.Timezone).Scan(&knownZone); e != nil {
		return QuietHours{}, e
	}
	if !knownZone {
		return QuietHours{}, ErrForbidden
	}
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return QuietHours{}, e
	}
	defer tx.Rollback(ctx)
	var id string
	if e = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, user).Scan(&id); e != nil {
		return QuietHours{}, norm(e)
	}
	var current int64
	e = tx.QueryRow(ctx, `SELECT version FROM account_quiet_hours WHERE user_id=$1`, user).Scan(&current)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return QuietHours{}, e
	}
	if current != in.ExpectedVersion {
		return QuietHours{}, ErrConflict
	}
	start, _ := clockMinute(in.StartTime)
	end, _ := clockMinute(in.EndTime)
	_, e = tx.Exec(ctx, `INSERT INTO account_quiet_hours(user_id,version,enabled,timezone,weekdays,start_minute,end_minute) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET version=EXCLUDED.version,enabled=EXCLUDED.enabled,timezone=EXCLUDED.timezone,weekdays=EXCLUDED.weekdays,start_minute=EXCLUDED.start_minute,end_minute=EXCLUDED.end_minute`, user, current+1, in.Enabled, in.Timezone, in.Weekdays, start, end)
	if e != nil {
		return QuietHours{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return QuietHours{}, e
	}
	return s.QuietHours(ctx, user, now)
}

type NotificationAttentionDecision struct {
	Allowed    bool       `json:"allowed"`
	ServerTime time.Time  `json:"server_time"`
	QuietUntil *time.Time `json:"quiet_until,omitempty"`
}

// NotificationAttention evaluates account policy and ordinary room attention.
// Reminders deliberately ignore room mode/mute, but never account quiet/DND.
func (s *PostgresStore) NotificationAttention(ctx context.Context, user, room, kind string) (NotificationAttentionDecision, error) {
	out := NotificationAttentionDecision{ServerTime: time.Now().UTC()}
	q, e := s.QuietHours(ctx, user, out.ServerTime)
	if e != nil {
		return out, e
	}
	out.QuietUntil = q.QuietUntil
	if q.Active || q.AccountDND {
		return out, nil
	}
	if room == "" {
		out.Allowed = true
		return out, nil
	}
	var allowed bool
	var mode string
	var until *time.Time
	e = s.DB.QueryRow(ctx, `SELECT can_access_room($1,$2),COALESCE(p.mode,'all'),p.muted_until FROM rooms r LEFT JOIN room_notification_preferences p ON p.room_id=r.id AND p.user_id=$2 WHERE r.id=$1`, room, user).Scan(&allowed, &mode, &until)
	if e != nil {
		return out, norm(e)
	}
	out.Allowed = allowed && (kind == "reminder" || mode != "mute" && (until == nil || !until.After(out.ServerTime)))
	return out, nil
}
func (s *PostgresStore) TimedNotificationMutes(ctx context.Context, user string) (map[string]time.Time, error) {
	out := map[string]time.Time{}
	rows, e := s.DB.Query(ctx, `SELECT room_id::text,muted_until FROM room_notification_preferences WHERE user_id=$1 AND muted_until>clock_timestamp() AND can_access_room(room_id,$1)`, user)
	if e != nil {
		return out, e
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var until time.Time
		if e = rows.Scan(&id, &until); e != nil {
			return out, e
		}
		out[id] = until
	}
	return out, rows.Err()
}
func (s *PostgresStore) SetTimedNotificationPreference(ctx context.Context, room, user string, mode *string, until *time.Time, changeMute bool, expected ...*int64) error {
	tx, e := s.personalTx(ctx, user, room)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var version int64
	e = tx.QueryRow(ctx, `SELECT version FROM room_notification_preferences WHERE room_id=$1 AND user_id=$2 FOR UPDATE`, room, user).Scan(&version)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	if len(expected) > 0 && expected[0] != nil && *expected[0] != version {
		return ErrConflict
	}
	_, e = tx.Exec(ctx, `INSERT INTO room_notification_preferences(room_id,user_id,mode,muted_until,version) VALUES($1,$2,COALESCE($3,'all'),$4,1) ON CONFLICT(room_id,user_id) DO UPDATE SET mode=COALESCE($3,room_notification_preferences.mode),muted_until=CASE WHEN $5 THEN $4 ELSE room_notification_preferences.muted_until END,version=room_notification_preferences.version+1`, room, user, mode, until, changeMute)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) NotificationPreferenceVersions(ctx context.Context, user string) (map[string]int64, error) {
	out := map[string]int64{}
	rows, e := s.DB.Query(ctx, `SELECT room_id::text,version FROM room_notification_preferences WHERE user_id=$1 AND can_access_room(room_id,$1)`, user)
	if e != nil {
		return out, e
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var version int64
		if e = rows.Scan(&id, &version); e != nil {
			return out, e
		}
		out[id] = version
	}
	return out, rows.Err()
}
