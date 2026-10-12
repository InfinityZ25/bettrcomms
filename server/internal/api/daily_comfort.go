package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

type PersonalSavedItem struct {
	ID         string             `json:"id"`
	Kind       string             `json:"kind"`
	RoomID     string             `json:"room_id"`
	RoomName   string             `json:"room_name"`
	Message    *Message           `json:"message,omitempty"`
	Attachment *MessageAttachment `json:"attachment,omitempty"`
	CreatedAt  time.Time          `json:"created_at"`
}
type PersonalSavedPage struct {
	Items      []PersonalSavedItem `json:"items"`
	NextCursor string              `json:"next_cursor,omitempty"`
}
type PersonalReminder struct {
	ID        string    `json:"id"`
	RoomID    string    `json:"room_id"`
	RoomName  string    `json:"room_name"`
	Message   *Message  `json:"message"`
	DueAt     time.Time `json:"due_at"`
	CreatedAt time.Time `json:"created_at"`
	State     string    `json:"state"`
	Version   int64     `json:"version"`
}
type PersonalReminderPage struct {
	Reminders  []PersonalReminder `json:"reminders"`
	NextCursor string             `json:"next_cursor,omitempty"`
}
type TextDraft struct {
	RoomID       string     `json:"room_id"`
	ThreadRootID *string    `json:"thread_root_id,omitempty"`
	Body         string     `json:"body"`
	ReplyToID    *string    `json:"reply_to_id,omitempty"`
	Version      int64      `json:"version"`
	MutationID   *string    `json:"mutation_id,omitempty"`
	UpdatedAt    *time.Time `json:"updated_at,omitempty"`
}
type TextDraftPage struct {
	Drafts     []TextDraft `json:"drafts"`
	NextCursor string      `json:"next_cursor,omitempty"`
}
type TextDraftInput struct {
	Body            string `json:"body"`
	ReplyToID       string `json:"reply_to_id"`
	ExpectedVersion int64  `json:"expected_version"`
	MutationID      string `json:"mutation_id"`
}
type DraftSyncSettings struct {
	Enabled bool  `json:"enabled"`
	Version int64 `json:"version"`
}
type QuietHours struct {
	Version      int64      `json:"version"`
	Enabled      bool       `json:"enabled"`
	Timezone     string     `json:"timezone"`
	Weekdays     []int      `json:"weekdays"`
	StartTime    string     `json:"start_time"`
	EndTime      string     `json:"end_time"`
	Active       bool       `json:"active"`
	QuietUntil   *time.Time `json:"quiet_until,omitempty"`
	NextChangeAt *time.Time `json:"next_change_at,omitempty"`
	ServerTime   time.Time  `json:"server_time"`
	AccountDND   bool       `json:"account_dnd"`
}
type QuietHoursInput struct {
	ExpectedVersion int64  `json:"expected_version"`
	Enabled         bool   `json:"enabled"`
	Timezone        string `json:"timezone"`
	Weekdays        []int  `json:"weekdays"`
	StartTime       string `json:"start_time"`
	EndTime         string `json:"end_time"`
}
type ReminderDeviceInput struct {
	DeviceID  string `json:"device_id"`
	Transport string `json:"transport"`
	DND       bool   `json:"dnd"`
	Alerts    bool   `json:"alerts"`
}
type ReminderAttentionClaim struct {
	LeaseID   string     `json:"lease_id,omitempty"`
	Tag       string     `json:"tag,omitempty"`
	Count     int        `json:"count"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

var ErrPersonalLimit = errors.New("personal item limit reached")
var ErrDailyCursor = errors.New("invalid personal cursor")
var ErrDraftSyncDisabled = errors.New("draft sync disabled")
var ErrReminderTime = errors.New("reminder time must be in the future")

func validDraftInput(in TextDraftInput) bool {
	return utf8.ValidString(in.Body) && !strings.ContainsRune(in.Body, '\x00') && utf8.RuneCountInString(in.Body) <= 4000 && in.ExpectedVersion >= 0 &&
		uuidPattern.MatchString(in.MutationID) && (in.ReplyToID == "" || uuidPattern.MatchString(in.ReplyToID))
}

// HandleDailyComfort is called only inside the authenticated access boundary.
func (a *API) HandleDailyComfort(w http.ResponseWriter, r *http.Request, path string, user User) bool {
	if a.handleDailyComfortAliases(w, r, path, user) {
		return true
	}
	p := strings.Split(path, "/")
	personal := strings.HasPrefix(path, "me/saved-items") || strings.HasPrefix(path, "me/message-reminders") ||
		path == "me/drafts" || path == "me/draft-sync" || path == "me/draft-settings" || path == "me/quiet-hours" || path == "me/notification-policy" || strings.HasPrefix(path, "me/reminder-attention/")
	draft := len(p) == 3 && p[0] == "rooms" && (p[2] == "drafts" || p[2] == "draft")
	reminder := len(p) == 5 && p[0] == "rooms" && p[2] == "messages" && p[4] == "reminder"
	if !personal && !draft && !reminder {
		return false
	}
	s, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "personal tools unavailable")
		return true
	}
	if r.Method != http.MethodGet && !a.limiter.allow("daily-comfort:"+user.ID, 180, time.Minute) {
		a.fail(w, 429, "rate_limited", "too many personal changes")
		return true
	}
	done := func(v any, err error, event string) {
		if err == nil && event != "" {
			a.Realtime.publishUser(user.ID, wire{Type: event})
		}
		if errors.Is(err, ErrPersonalLimit) {
			a.fail(w, 409, "personal_limit", "remove an existing personal item before adding another")
			return
		}
		if errors.Is(err, ErrDailyCursor) {
			a.fail(w, 400, "invalid_cursor", "invalid personal page cursor")
			return
		}
		if errors.Is(err, ErrDraftSyncDisabled) {
			a.fail(w, 409, "draft_sync_disabled", "draft synchronization is disabled for this account")
			return
		}
		if errors.Is(err, ErrReminderTime) {
			a.fail(w, 400, "invalid_reminder", "choose a future reminder time within one year")
			return
		}
		a.result(w, v, err)
	}
	switch {
	case path == "me/saved-items" && r.Method == http.MethodGet:
		if r.URL.Query().Get("index") == "1" {
			v, e := s.PersonalSavedIndex(r.Context(), user.ID)
			done(v, e, "")
			break
		}
		kind := r.URL.Query().Get("kind")
		if kind == "" {
			kind = "all"
		}
		if kind != "all" && kind != "message" && kind != "link" && kind != "file" {
			a.fail(w, 400, "invalid_filter", "choose a saved item type")
			break
		}
		v, e := s.PersonalSavedItems(r.Context(), user.ID, kind, r.URL.Query().Get("cursor"), pageLimit(r))
		done(v, e, "")
	case len(p) == 4 && p[0] == "me" && p[1] == "saved-items" && (p[2] == "message" || p[2] == "file") && uuidPattern.MatchString(p[3]) && (r.Method == http.MethodPut || r.Method == http.MethodDelete):
		e := s.SetPersonalSavedItem(r.Context(), user.ID, p[2], strings.ToLower(p[3]), r.Method == http.MethodPut)
		done(map[string]bool{"ok": true}, e, "personal.saved.changed")
	case path == "me/message-reminders" && r.Method == http.MethodGet:
		state := r.URL.Query().Get("state")
		if state == "" {
			state = "active"
		}
		if state != "active" && state != "pending" && state != "due" {
			a.fail(w, 400, "invalid_filter", "choose an active reminder state")
			break
		}
		v, e := s.PersonalReminders(r.Context(), user.ID, state, r.URL.Query().Get("cursor"), pageLimit(r))
		done(v, e, "")
	case reminder && uuidPattern.MatchString(p[1]) && uuidPattern.MatchString(p[3]) && r.Method == http.MethodPut:
		var in struct {
			DueAt      time.Time `json:"due_at"`
			MutationID string    `json:"mutation_id"`
		}
		if !a.decode(w, r, &in) {
			break
		}
		now := time.Now()
		if !uuidPattern.MatchString(in.MutationID) || in.DueAt.IsZero() || in.DueAt.After(now.Add(366*24*time.Hour)) {
			a.fail(w, 400, "invalid_reminder", "choose a future time within one year")
			break
		}
		v, e := s.SetPersonalReminder(r.Context(), user.ID, p[1], p[3], in.DueAt, in.MutationID)
		done(v, e, "personal.reminders.changed")
	case reminder && uuidPattern.MatchString(p[1]) && uuidPattern.MatchString(p[3]) && r.Method == http.MethodDelete:
		e := s.RemovePersonalReminder(r.Context(), user.ID, "", p[1], p[3])
		done(map[string]bool{"ok": true}, e, "personal.reminders.changed")
	case len(p) == 4 && p[0] == "me" && p[1] == "message-reminders" && p[3] == "complete" && uuidPattern.MatchString(p[2]) && r.Method == http.MethodPost:
		e := s.RemovePersonalReminder(r.Context(), user.ID, p[2], "", "")
		done(map[string]bool{"ok": true}, e, "personal.reminders.changed")
	case (path == "me/draft-sync" || path == "me/draft-settings") && r.Method == http.MethodGet:
		v, e := s.DraftSettings(r.Context(), user.ID)
		done(v, e, "")
	case (path == "me/draft-sync" || path == "me/draft-settings") && r.Method == http.MethodPut:
		var in struct {
			Enabled         *bool `json:"enabled"`
			ExpectedVersion int64 `json:"expected_version"`
		}
		if !a.decode(w, r, &in) {
			break
		}
		if in.Enabled == nil || in.ExpectedVersion < 0 {
			a.fail(w, 400, "invalid_settings", "choose draft synchronization and its version")
			break
		}
		v, e := s.SetDraftSettings(r.Context(), user.ID, *in.Enabled, in.ExpectedVersion)
		done(v, e, "draft-sync.changed")
	case path == "me/drafts" && r.Method == http.MethodGet:
		v, e := s.TextDrafts(r.Context(), user.ID, r.URL.Query().Get("cursor"), pageLimit(r))
		done(v, e, "")
	case draft && uuidPattern.MatchString(p[1]):
		root := r.URL.Query().Get("thread_root_id")
		if root != "" && !uuidPattern.MatchString(root) {
			a.fail(w, 400, "invalid_thread", "choose a valid draft thread")
			break
		}
		if r.Method == http.MethodGet {
			v, e := s.TextDraft(r.Context(), user.ID, p[1], root)
			done(v, e, "")
			break
		}
		if r.Method != http.MethodPut {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			break
		}
		var in TextDraftInput
		if !a.decode(w, r, &in) {
			break
		}
		if !validDraftInput(in) {
			a.fail(w, 400, "invalid_draft", "draft text and revision are invalid")
			break
		}
		v, e := s.PutTextDraft(r.Context(), user.ID, p[1], root, in)
		if errors.Is(e, ErrConflict) {
			a.json(w, 409, map[string]any{"error": apiError{Code: "draft_changed", Message: "another device changed this draft; keep both versions until you choose"}, "draft": v})
			break
		}
		done(v, e, "personal.drafts.changed")
	case path == "me/quiet-hours" && r.Method == http.MethodGet:
		v, e := s.QuietHours(r.Context(), user.ID, time.Now())
		done(v, e, "")
	case path == "me/notification-policy" && r.Method == http.MethodGet:
		room := r.URL.Query().Get("room_id")
		kind := r.URL.Query().Get("kind")
		if kind == "" {
			kind = "message"
		}
		if room != "" && !uuidPattern.MatchString(room) || kind != "message" && kind != "call" && kind != "reminder" {
			a.fail(w, 400, "invalid_policy", "choose a valid conversation and attention type")
			break
		}
		v, e := s.NotificationAttention(r.Context(), user.ID, room, kind)
		done(v, e, "")
	case path == "me/quiet-hours" && r.Method == http.MethodPut:
		var in QuietHoursInput
		if !a.decode(w, r, &in) {
			break
		}
		if !validQuietHours(in) {
			a.fail(w, 400, "invalid_quiet_hours", "choose valid weekdays, different times and an IANA timezone")
			break
		}
		v, e := s.SetQuietHours(r.Context(), user.ID, in, time.Now())
		done(v, e, "notification.policy.changed")
	case path == "me/reminder-attention/device" && r.Method == http.MethodPut:
		var in ReminderDeviceInput
		if !a.decode(w, r, &in) {
			break
		}
		if !uuidPattern.MatchString(in.DeviceID) || (in.Transport != "page" && in.Transport != "desktop") {
			a.fail(w, 400, "invalid_device", "choose a valid notification device")
			break
		}
		session, _ := r.Context().Value(sessionKey{}).(string)
		e := s.RegisterReminderDevice(r.Context(), user.ID, session, in)
		done(map[string]bool{"ok": true}, e, "")
	case path == "me/reminder-attention/claim" && r.Method == http.MethodPost:
		var in struct {
			DeviceID string `json:"device_id"`
		}
		if !a.decode(w, r, &in) {
			break
		}
		if !uuidPattern.MatchString(in.DeviceID) {
			a.fail(w, 400, "invalid_device", "choose a notification device")
			break
		}
		v, e := s.ClaimReminderAttention(r.Context(), user.ID, in.DeviceID, false)
		done(v, e, "")
	case path == "me/reminder-attention/ack" && r.Method == http.MethodPost:
		var in struct {
			DeviceID string `json:"device_id"`
			LeaseID  string `json:"lease_id"`
		}
		if !a.decode(w, r, &in) {
			break
		}
		if !uuidPattern.MatchString(in.DeviceID) || !uuidPattern.MatchString(in.LeaseID) {
			a.fail(w, 400, "invalid_claim", "choose a valid notification claim")
			break
		}
		e := s.AcknowledgeReminderAttention(r.Context(), user.ID, in.DeviceID, in.LeaseID)
		done(map[string]bool{"ok": true}, e, "")
	default:
		a.fail(w, 405, "method_not_allowed", "method not allowed")
	}
	return true
}

func (a *API) publishPersonalInvalidation(user, event string) {
	a.Realtime.publishUser(user, wire{Type: event, Payload: json.RawMessage(`{}`)})
}
