package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// These canonical personal routes coexist with the context-menu room routes.
func (a *API) handleDailyComfortAliases(w http.ResponseWriter, r *http.Request, path string, user User) bool {
	p := strings.Split(path, "/")
	combined := path == "me/reminders"
	settings := path == "me/notification-settings"
	save := path == "me/saved-items" && r.Method == http.MethodPut
	unsave := len(p) == 3 && p[0] == "me" && p[1] == "saved-items"
	reminder := path == "me/message-reminders" && (r.Method == http.MethodPost || r.Method == http.MethodPut) || len(p) == 3 && p[0] == "me" && p[1] == "message-reminders"
	if !combined && !settings && !save && !unsave && !reminder {
		return false
	}
	s, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "personal tools unavailable")
		return true
	}
	forward := func(method, next string, body any) {
		copy := r.Clone(r.Context())
		copy.Method = method
		if body != nil {
			raw, _ := json.Marshal(body)
			copy.Body = io.NopCloser(bytes.NewReader(raw))
			copy.Header = copy.Header.Clone()
			copy.Header.Set("Content-Type", "application/json")
		}
		a.HandleDailyComfort(w, copy, next, user)
	}
	switch {
	case combined && r.Method == http.MethodGet:
		v, e := s.CombinedPersonalReminders(r.Context(), user.ID, r.URL.Query().Get("cursor"), pageLimit(r))
		if e == ErrDailyCursor {
			a.fail(w, 400, "invalid_cursor", "invalid reminder page cursor")
		} else {
			a.result(w, v, e)
		}
	case settings && r.Method == http.MethodGet:
		forward(http.MethodGet, "me/quiet-hours", nil)
	case settings && r.Method == http.MethodPatch:
		var patch map[string]json.RawMessage
		if !a.decode(w, r, &patch) {
			break
		}
		q, e := s.QuietHours(r.Context(), user.ID, time.Now())
		if e != nil {
			a.result(w, nil, e)
			break
		}
		in := QuietHoursInput{ExpectedVersion: q.Version, Enabled: q.Enabled, Timezone: q.Timezone, Weekdays: q.Weekdays, StartTime: q.StartTime, EndTime: q.EndTime}
		valid := len(patch) > 1
		for key, value := range patch {
			if key != "expected_version" && key != "enabled" && key != "timezone" && key != "weekdays" && key != "start_time" && key != "end_time" || string(value) == "null" {
				valid = false
			}
		}
		if _, ok := patch["expected_version"]; !ok {
			valid = false
		}
		raw, _ := json.Marshal(patch)
		if json.Unmarshal(raw, &in) != nil {
			valid = false
		}
		if !valid {
			a.fail(w, 400, "invalid_settings", "provide a valid quiet policy patch and its version")
			break
		}
		forward(http.MethodPut, "me/quiet-hours", in)
	case save:
		var in struct {
			Kind         string `json:"kind"`
			SourceID     string `json:"source_id"`
			MessageID    string `json:"message_id"`
			AttachmentID string `json:"attachment_id"`
		}
		if !a.decode(w, r, &in) {
			break
		}
		source := in.SourceID
		if source == "" {
			if in.MessageID != "" && in.AttachmentID == "" {
				source = in.MessageID
				in.Kind = "message"
			} else if in.AttachmentID != "" && in.MessageID == "" {
				source = in.AttachmentID
				in.Kind = "file"
			}
		}
		if (in.Kind != "message" && in.Kind != "file") || !uuidPattern.MatchString(source) {
			a.fail(w, 400, "invalid_saved_item", "choose an authorized message or file")
			break
		}
		forward(http.MethodPut, "me/saved-items/"+in.Kind+"/"+source, nil)
	case unsave && r.Method == http.MethodDelete && uuidPattern.MatchString(p[2]):
		if !a.limiter.allow("daily-comfort:"+user.ID, 180, time.Minute) {
			a.fail(w, 429, "rate_limited", "too many personal changes")
			break
		}
		_, e := s.DB.Exec(r.Context(), `DELETE FROM personal_saved_items WHERE user_id=$1 AND id=$2`, user.ID, p[2])
		if e == nil {
			a.publishPersonalInvalidation(user.ID, "personal.saved.changed")
		}
		a.result(w, map[string]bool{"ok": true}, e)
	case reminder && len(p) == 2:
		var in struct {
			RoomID     string    `json:"room_id"`
			MessageID  string    `json:"message_id"`
			DueAt      time.Time `json:"due_at"`
			MutationID string    `json:"mutation_id"`
		}
		if !a.decode(w, r, &in) {
			break
		}
		if !uuidPattern.MatchString(in.RoomID) || !uuidPattern.MatchString(in.MessageID) {
			a.fail(w, 400, "invalid_reminder", "choose a message in a readable conversation")
			break
		}
		forward(http.MethodPut, "rooms/"+in.RoomID+"/messages/"+in.MessageID+"/reminder", map[string]any{"due_at": in.DueAt, "mutation_id": in.MutationID})
	case reminder && len(p) == 3 && uuidPattern.MatchString(p[2]):
		if r.Method == http.MethodDelete {
			forward(http.MethodPost, "me/message-reminders/"+p[2]+"/complete", nil)
			break
		}
		v, e := s.PersonalReminderByID(r.Context(), user.ID, p[2])
		if e != nil {
			a.result(w, nil, e)
			break
		}
		if r.Method == http.MethodGet {
			a.result(w, v, nil)
			break
		}
		if r.Method == http.MethodPut || r.Method == http.MethodPatch {
			var in struct {
				DueAt      time.Time `json:"due_at"`
				MutationID string    `json:"mutation_id"`
			}
			if !a.decode(w, r, &in) {
				break
			}
			forward(http.MethodPut, "rooms/"+v.RoomID+"/messages/"+v.Message.ID+"/reminder", in)
			break
		}
		a.fail(w, 405, "method_not_allowed", "method not allowed")
	default:
		a.fail(w, 405, "method_not_allowed", "method not allowed")
	}
	return true
}

func (s *PostgresStore) PersonalReminderByID(ctx context.Context, user, id string) (PersonalReminder, error) {
	var v PersonalReminder
	var message string
	e := s.DB.QueryRow(ctx, `SELECT p.id::text,m.room_id::text,r.name,p.due_at,p.created_at,p.state,p.version,m.id::text FROM personal_message_reminders p JOIN messages m ON m.id=p.message_id JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=p.user_id AND u.deleted_at IS NULL WHERE p.user_id=$1 AND p.id=$2 AND m.deleted_at IS NULL AND can_access_room(m.room_id,$1)`, user, id).Scan(&v.ID, &v.RoomID, &v.RoomName, &v.DueAt, &v.CreatedAt, &v.State, &v.Version, &message)
	if e != nil {
		return v, norm(e)
	}
	messages, e := s.personalMessages(ctx, user, []string{message})
	if e != nil {
		return v, e
	}
	v.Message = messages[message]
	if v.Message == nil {
		return v, ErrNotFound
	}
	return v, nil
}

type CombinedPersonalReminder struct {
	ID        string                `json:"id"`
	Kind      string                `json:"kind"`
	RoomID    string                `json:"room_id"`
	RoomName  string                `json:"room_name"`
	DueAt     time.Time             `json:"due_at"`
	CreatedAt time.Time             `json:"created_at"`
	State     string                `json:"state"`
	Message   *Message              `json:"message,omitempty"`
	Event     *ChannelEventReminder `json:"event,omitempty"`
}
type CombinedPersonalReminderPage struct {
	Reminders  []CombinedPersonalReminder `json:"reminders"`
	NextCursor string                     `json:"next_cursor,omitempty"`
}

func (s *PostgresStore) CombinedPersonalReminders(ctx context.Context, user, cursor string, limit int) (CombinedPersonalReminderPage, error) {
	out := CombinedPersonalReminderPage{Reminders: []CombinedPersonalReminder{}}
	c, e := readPersonalCursor(cursor)
	if e != nil {
		return out, e
	}
	limit = boundedPersonalLimit(limit)
	var at *time.Time
	if !c.At.IsZero() {
		at = &c.At
	}
	rows, e := s.DB.Query(ctx, `SELECT id,kind,room_id,room_name,due_at,created_at,state,message_id,event_id,title,starts_at FROM (
 SELECT p.id::text id,'message' kind,m.room_id::text room_id,r.name room_name,p.due_at,p.created_at,p.state,m.id::text message_id,NULL::text event_id,NULL::text title,NULL::timestamptz starts_at FROM personal_message_reminders p JOIN messages m ON m.id=p.message_id JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=p.user_id AND u.deleted_at IS NULL WHERE p.user_id=$1 AND m.deleted_at IS NULL AND can_access_room(m.room_id,$1)
 UNION ALL
 SELECT n.id::text,'event',e.room_id::text,r.name,e.starts_at-interval '10 minutes',n.created_at,'due',NULL::text,e.id::text,e.title,e.starts_at FROM channel_event_reminders n JOIN channel_scheduled_events e ON e.id=n.event_id JOIN rooms r ON r.id=e.room_id JOIN channel_event_rsvps v ON v.event_id=e.id AND v.user_id=n.user_id JOIN users u ON u.id=n.user_id AND u.deleted_at IS NULL WHERE n.user_id=$1 AND n.acknowledged_at IS NULL AND e.cancelled_at IS NULL AND v.response IN('going','maybe') AND can_access_room(e.room_id,$1)
 ) reminders WHERE ($2::timestamptz IS NULL OR (due_at,id::uuid)>($2,NULLIF($3,'')::uuid)) ORDER BY due_at,id::uuid LIMIT $4`, user, at, c.ID, limit+1)
	if e != nil {
		return out, e
	}
	ids := []string{}
	messageIDs := []string{}
	for rows.Next() {
		var v CombinedPersonalReminder
		var mid, eid, title *string
		var starts *time.Time
		if e = rows.Scan(&v.ID, &v.Kind, &v.RoomID, &v.RoomName, &v.DueAt, &v.CreatedAt, &v.State, &mid, &eid, &title, &starts); e != nil {
			break
		}
		id := ""
		if mid != nil {
			id = *mid
			ids = append(ids, id)
		}
		messageIDs = append(messageIDs, id)
		if eid != nil {
			v.Event = &ChannelEventReminder{ID: v.ID, EventID: *eid, RoomID: v.RoomID, RoomName: v.RoomName, Title: *title, StartsAt: *starts, CreatedAt: v.CreatedAt}
		}
		out.Reminders = append(out.Reminders, v)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return out, e
	}
	if len(out.Reminders) > limit {
		out.Reminders = out.Reminders[:limit]
		last := out.Reminders[limit-1]
		out.NextCursor = writePersonalCursor(last.DueAt, last.ID, "")
	}
	messages, e := s.personalMessages(ctx, user, ids)
	if e != nil {
		return out, e
	}
	filtered := out.Reminders[:0]
	for i, v := range out.Reminders {
		v.Message = messages[messageIDs[i]]
		if v.Kind == "message" && v.Message == nil {
			continue
		}
		filtered = append(filtered, v)
	}
	out.Reminders = filtered
	return out, nil
}
