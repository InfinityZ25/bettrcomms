package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type CustomStatus struct {
	Text      string     `json:"text"`
	Emoji     string     `json:"emoji"`
	ExpiresAt *time.Time `json:"expires_at"`
}
type StatusSnapshot struct {
	Status  CustomStatus `json:"status"`
	Version int64        `json:"version"`
}
type ConversationPreference struct {
	Favorite bool  `json:"favorite"`
	Archived bool  `json:"archived"`
	Version  int64 `json:"version"`
}
type AccountPreferences struct {
	Version  int64                      `json:"version"`
	Settings map[string]json.RawMessage `json:"settings"`
}
type PublicUser struct {
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	Username       *string      `json:"username"`
	Bio            string       `json:"bio"`
	AvatarURL      *string      `json:"avatar_url"`
	CreatedAt      time.Time    `json:"created_at"`
	ProfileVersion int64        `json:"profile_version"`
	CustomStatus   CustomStatus `json:"custom_status"`
	StatusVersion  int64        `json:"status_version"`
}
type UserProfile struct {
	User            PublicUser   `json:"user"`
	Relationship    string       `json:"relationship"`
	FriendRequestID string       `json:"friend_request_id,omitempty"`
	Presence        string       `json:"presence"`
	SharedRooms     []Room       `json:"shared_rooms"`
	MutualFriends   []PublicUser `json:"mutual_friends"`
}
type ActivityItem struct {
	ID            string         `json:"id"`
	Kind          string         `json:"kind"`
	CreatedAt     time.Time      `json:"created_at"`
	Read          bool           `json:"read"`
	RoomID        string         `json:"room_id,omitempty"`
	Message       *Message       `json:"message,omitempty"`
	FriendRequest *FriendRequest `json:"friend_request,omitempty"`
	DMRequest     *DMRequest     `json:"dm_request,omitempty"`
}
type ActivityPage struct {
	Items      []ActivityItem `json:"items"`
	NextCursor string         `json:"next_cursor,omitempty"`
}
type activityCursor struct {
	Time time.Time `json:"t"`
	ID   string    `json:"id"`
}

// Optional contract preserves lightweight legacy stores while keeping new reads
// and writes authorized by the same persistence implementation.
type DailyStore interface {
	PublicProfile(string, string) (UserProfile, error)
	CustomStatus(string) (StatusSnapshot, error)
	SetCustomStatus(string, CustomStatus) (StatusSnapshot, error)
	StatusRecipients(string) ([]string, error)
	ConversationPreferences(string) (map[string]ConversationPreference, error)
	SetConversationPreference(string, string, *bool, *bool) (ConversationPreference, error)
	AccountPreferences(string) (AccountPreferences, error)
	PatchAccountPreferences(string, int64, map[string]json.RawMessage) (AccountPreferences, error)
	Activity(string, string, activityCursor, int) (ActivityPage, error)
}

func validatePreferencePatch(settings map[string]json.RawMessage) bool {
	if len(settings) == 0 || len(settings) > 7 {
		return false
	}
	for key, value := range settings {
		switch key {
		case "theme", "layout":
			var v string
			if json.Unmarshal(value, &v) != nil {
				return false
			}
			if key == "theme" && v != "dark" && v != "light" && v != "system" {
				return false
			}
			if key == "layout" && v != "top" && v != "side" && v != "right" {
				return false
			}
		case "balanced", "sounds_enabled":
			var v *bool
			if json.Unmarshal(value, &v) != nil || v == nil {
				return false
			}
		case "sound_volume":
			var v *float64
			if json.Unmarshal(value, &v) != nil || v == nil || *v < 0 || *v > 1 {
				return false
			}
		case "sounds":
			var v map[string]json.RawMessage
			if json.Unmarshal(value, &v) != nil || v == nil || len(v) > 5 {
				return false
			}
			for name, enabled := range v {
				if name != "join" && name != "leave" && name != "notification" && name != "ringtone" && name != "share" {
					return false
				}
				var flag *bool
				if json.Unmarshal(enabled, &flag) != nil || flag == nil {
					return false
				}
			}
		default:
			return false
		}
	}
	return true
}
func validCustomStatus(status CustomStatus, now time.Time) bool {
	if !utf8.ValidString(status.Text) || utf8.RuneCountInString(status.Text) > 100 || status.Emoji != "" && !reactionChoices[status.Emoji] {
		return false
	}
	for _, r := range status.Text {
		if unicode.IsControl(r) {
			return false
		}
	}
	return status.ExpiresAt == nil || (status.ExpiresAt.After(now) && !status.ExpiresAt.After(now.Add(30*24*time.Hour)))
}
func (a *API) daily(w http.ResponseWriter, r *http.Request, u User, path string) {
	s, ok := a.Store.(DailyStore)
	if !ok {
		a.fail(w, 503, "unavailable", "feature unavailable")
		return
	}
	if r.Method != http.MethodGet && !a.limiter.allow("daily-preferences:"+u.ID, 120, time.Minute) {
		a.fail(w, 429, "rate_limited", "too many changes")
		return
	}
	switch {
	case strings.HasPrefix(path, "users/"):
		parts := strings.Split(path, "/")
		if r.Method != http.MethodGet || len(parts) != 3 || parts[2] != "profile" || !uuidPattern.MatchString(parts[1]) {
			a.fail(w, 404, "not_found", "profile not found")
			return
		}
		if !a.limiter.allow("profile-read:"+u.ID, 120, time.Minute) {
			a.fail(w, 429, "rate_limited", "too many profile reads")
			return
		}
		result, err := s.PublicProfile(strings.ToLower(parts[1]), u.ID)
		if err == nil {
			a.Realtime.mu.RLock()
			result.Presence = a.Realtime.effectivePresenceLocked(result.User.ID)
			a.Realtime.mu.RUnlock()
		}
		a.result(w, result, err)
	case path == "me/status":
		if r.Method == http.MethodGet {
			v, e := s.CustomStatus(u.ID)
			a.result(w, v, e)
			return
		}
		if r.Method != http.MethodPut {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return
		}
		var input struct {
			Status *CustomStatus `json:"status"`
		}
		if !a.decode(w, r, &input) {
			return
		}
		if input.Status == nil {
			a.fail(w, 400, "invalid_status", "provide a status")
			return
		}
		in := *input.Status
		in.Text = strings.TrimSpace(in.Text)
		if !validCustomStatus(in, time.Now()) {
			a.fail(w, 400, "invalid_status", "status must be at most 100 characters with a supported emoji and future expiry within 30 days")
			return
		}
		if in.Text == "" && in.Emoji == "" {
			in.ExpiresAt = nil
		}
		v, e := s.SetCustomStatus(u.ID, in)
		if e == nil {
			a.publishCustomStatusContext(r.Context(), u.ID, v, s)
		}
		a.result(w, v, e)
	case path == "me/conversations":
		if r.Method != http.MethodGet {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return
		}
		v, e := s.ConversationPreferences(u.ID)
		a.result(w, map[string]any{"preferences": v}, e)
	case strings.HasPrefix(path, "rooms/"):
		p := strings.Split(path, "/")
		if len(p) != 3 || !uuidPattern.MatchString(p[1]) || r.Method != http.MethodPut {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return
		}
		p[1] = strings.ToLower(p[1])
		var in struct {
			Favorite *bool `json:"favorite"`
			Archived *bool `json:"archived"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if in.Favorite == nil && in.Archived == nil {
			a.fail(w, 400, "invalid_preferences", "provide favorite or archived")
			return
		}
		v, e := s.SetConversationPreference(p[1], u.ID, in.Favorite, in.Archived)
		payload := map[string]any{"room_id": p[1], "favorite": v.Favorite, "archived": v.Archived, "version": v.Version}
		if e == nil {
			encoded, _ := json.Marshal(payload)
			a.Realtime.publishUser(u.ID, wire{Type: "conversation.preferences", Payload: encoded})
		}
		a.result(w, payload, e)
	case path == "me/preferences":
		if r.Method == http.MethodGet {
			v, e := s.AccountPreferences(u.ID)
			a.result(w, v, e)
			return
		}
		if r.Method != http.MethodPatch {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return
		}
		var in struct {
			Version  *int64                     `json:"version"`
			Settings map[string]json.RawMessage `json:"settings"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if in.Version == nil || *in.Version < 0 || !validatePreferencePatch(in.Settings) {
			a.fail(w, 400, "invalid_preferences", "provide the current version and supported preference values")
			return
		}
		v, e := s.PatchAccountPreferences(u.ID, *in.Version, in.Settings)
		if e == ErrConflict {
			a.json(w, 409, map[string]any{"error": apiError{"preferences_conflict", "preferences changed on another device"}, "version": v.Version, "settings": v.Settings})
			return
		}
		if e == nil {
			payload, _ := json.Marshal(v)
			a.Realtime.publishUser(u.ID, wire{Type: "account.preferences", Payload: payload})
		}
		a.result(w, v, e)
	case path == "me/activity":
		if r.Method != http.MethodGet {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return
		}
		if !a.limiter.allow("activity:"+u.ID, 120, time.Minute) {
			a.fail(w, 429, "rate_limited", "too many activity reads")
			return
		}
		kind := r.URL.Query().Get("kind")
		if kind == "" {
			kind = "all"
		}
		if kind != "all" && kind != "mentions" && kind != "replies" && kind != "requests" {
			a.fail(w, 400, "invalid_kind", "choose all, mentions, replies or requests")
			return
		}
		limit := 30
		if v := r.URL.Query().Get("limit"); v != "" {
			n, e := strconv.Atoi(v)
			if e != nil || n < 1 || n > 30 {
				a.fail(w, 400, "invalid_limit", "limit must be 1-30")
				return
			}
			limit = n
		}
		var cursor activityCursor
		if token := r.URL.Query().Get("before"); token != "" {
			if len(token) > 512 {
				a.fail(w, 400, "invalid_cursor", "invalid activity cursor")
				return
			}
			data, e := base64.RawURLEncoding.DecodeString(token)
			if e != nil || len(data) > 256 || json.Unmarshal(data, &cursor) != nil || cursor.Time.IsZero() || len(cursor.ID) > 80 || cursor.ID == "" {
				a.fail(w, 400, "invalid_cursor", "invalid activity cursor")
				return
			}
		}
		v, e := s.Activity(u.ID, kind, cursor, limit)
		a.result(w, v, e)
	}
}
func (a *API) publishCustomStatusContext(ctx context.Context, user string, status StatusSnapshot, s DailyStore) {
	var recipients []string
	var err error
	if postgres, ok := s.(*PostgresStore); ok {
		recipients, err = postgres.statusRecipientsContext(ctx, user)
	} else {
		recipients, err = s.StatusRecipients(user)
	}
	if err != nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{"user_id": user, "status": status.Status, "version": status.Version})
	for _, id := range recipients {
		if ctx.Err() != nil {
			return
		}
		a.Realtime.publishUser(id, wire{Type: "user.status", Payload: payload})
	}
}
