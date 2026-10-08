package api

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type ChannelPoll struct {
	ID        string     `json:"id"`
	AuthorID  *string    `json:"author_id"`
	Question  string     `json:"question"`
	Options   []string   `json:"options"`
	Counts    []int      `json:"counts"`
	Vote      *int       `json:"vote"`
	CreatedAt time.Time  `json:"created_at"`
	ClosesAt  *time.Time `json:"closes_at"`
	ClosedAt  *time.Time `json:"closed_at"`
}
type ScheduledChannelEvent struct {
	ID          string     `json:"id"`
	RoomID      string     `json:"room_id"`
	AuthorID    *string    `json:"author_id"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	StartsAt    time.Time  `json:"starts_at"`
	CancelledAt *time.Time `json:"cancelled_at"`
	Going       int        `json:"going"`
	Maybe       int        `json:"maybe"`
	Response    string     `json:"response"`
}
type ChannelEventReminder struct {
	ID        string    `json:"id"`
	EventID   string    `json:"event_id"`
	RoomID    string    `json:"room_id"`
	RoomName  string    `json:"room_name"`
	Title     string    `json:"title"`
	StartsAt  time.Time `json:"starts_at"`
	CreatedAt time.Time `json:"created_at"`
}
type WatchTogetherState struct {
	RoomID          string            `json:"room_id"`
	Attachment      MessageAttachment `json:"attachment"`
	HostID          *string           `json:"host_id"`
	Paused          bool              `json:"paused"`
	PositionSeconds float64           `json:"position_seconds"`
	Revision        int64             `json:"revision"`
	UpdatedAt       time.Time         `json:"updated_at"`
	ServerTime      time.Time         `json:"server_time"`
	CanClaim        bool              `json:"can_claim"`
}
type WatchTogetherCommand struct {
	Action          string  `json:"action"`
	AttachmentID    string  `json:"attachment_id"`
	HostID          string  `json:"host_id"`
	PositionSeconds float64 `json:"position_seconds"`
	Revision        int64   `json:"revision"`
}
type ChannelMediaAsset struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Kind       string            `json:"kind"`
	CreatorID  *string           `json:"creator_id"`
	Attachment MessageAttachment `json:"attachment"`
	DurationMS *int              `json:"duration_ms"`
}
type ChannelActivitySnapshot struct {
	Polls  []ChannelPoll           `json:"polls"`
	Events []ScheduledChannelEvent `json:"events"`
	Assets []ChannelMediaAsset     `json:"assets"`
	Watch  *WatchTogetherState     `json:"watch"`
}
type MessageEditVersion struct {
	Version   int64     `json:"version"`
	Body      string    `json:"body"`
	ChangedAt time.Time `json:"changed_at"`
}
type ChannelActivityStore interface {
	ChannelActivities(string, string) (ChannelActivitySnapshot, error)
	CreateChannelPoll(string, string, string, []string, *time.Time) error
	VoteChannelPoll(string, string, string, *int) error
	CloseChannelPoll(string, string, string) error
	CreateScheduledEvent(string, string, string, string, time.Time) error
	RSVPScheduledEvent(string, string, string, string) error
	CancelScheduledEvent(string, string, string) error
	EventReminders(string) ([]ChannelEventReminder, error)
	AcknowledgeEventReminder(string, string) error
	ChangeWatchTogether(string, string, WatchTogetherCommand) (*WatchTogetherState, error)
	CreateChannelMediaAsset(string, string, string, string, string, *int) error
	DeleteChannelMediaAsset(string, string, string) error
	ChannelMediaAsset(string, string, string) (ChannelMediaAsset, error)
	SendStickerMessage(string, string, string, string) (Message, bool, error)
	MessageEditHistory(string, string, string) ([]MessageEditVersion, error)
}

func activityText(value string, min, max int) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) < min || utf8.RuneCountInString(value) > max {
		return false
	}
	for _, c := range value {
		if unicode.IsControl(c) && c != '\n' && c != '\t' {
			return false
		}
	}
	return true
}
func validPoll(question string, options []string, closes *time.Time, now time.Time) bool {
	if !activityText(question, 1, 300) || len(options) < 2 || len(options) > 10 || closes != nil && (!closes.After(now) || closes.After(now.Add(90*24*time.Hour))) {
		return false
	}
	seen := map[string]bool{}
	for _, option := range options {
		key := strings.ToLower(strings.TrimSpace(option))
		if !activityText(option, 1, 100) || key == "" || seen[key] {
			return false
		}
		seen[key] = true
	}
	return true
}

func (a *API) publishChannelActivity(room, kind string) {
	data, _ := json.Marshal(map[string]string{"room_id": room, "kind": kind})
	a.Realtime.publishRoom(room, wire{Type: "channel.activity", Payload: data})
}

func (a *API) routeActivityFeatures(w http.ResponseWriter, r *http.Request, p []string, u User) bool {
	reminders := len(p) >= 2 && p[0] == "me" && p[1] == "event-reminders"
	history := len(p) == 5 && p[0] == "rooms" && p[2] == "messages" && p[4] == "history"
	channel := len(p) >= 3 && p[0] == "rooms" && (p[2] == "activities" || p[2] == "polls" || p[2] == "scheduled-events" || p[2] == "watch-together" || p[2] == "media-assets")
	if !reminders && !history && !channel {
		return false
	}
	s, ok := a.Store.(ChannelActivityStore)
	if !ok {
		a.fail(w, 503, "unavailable", "channel activities are unavailable")
		return true
	}
	if reminders {
		if len(p) == 2 && r.Method == http.MethodGet {
			v, e := s.EventReminders(u.ID)
			a.result(w, map[string]any{"reminders": v}, e)
		} else if len(p) == 3 && uuidPattern.MatchString(p[2]) && r.Method == http.MethodDelete {
			a.result(w, map[string]bool{"ok": true}, s.AcknowledgeEventReminder(u.ID, p[2]))
		} else {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
		}
		return true
	}
	room := strings.ToLower(p[1])
	if !uuidPattern.MatchString(room) {
		a.fail(w, 404, "not_found", "channel not found")
		return true
	}
	resolved, e := a.Store.RoomForMember(room, u.ID)
	if e != nil {
		a.result(w, nil, e)
		return true
	}
	if history {
		if r.Method != http.MethodGet {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
		} else if !uuidPattern.MatchString(p[3]) {
			a.fail(w, 404, "not_found", "message not found")
		} else {
			v, e := s.MessageEditHistory(room, u.ID, p[3])
			a.result(w, map[string]any{"versions": v}, e)
		}
		return true
	}
	if r.Method == http.MethodGet && p[2] == "activities" && len(p) == 3 {
		v, e := s.ChannelActivities(room, u.ID)
		a.result(w, v, e)
		return true
	}
	if len(p) >= 4 && !uuidPattern.MatchString(p[3]) {
		a.fail(w, 404, "not_found", "activity not found")
		return true
	}
	if r.Method != http.MethodGet && !a.limiter.allow("channel-activity:"+u.ID, 120, time.Minute) {
		a.fail(w, 429, "rate_limited", "too many activity changes")
		return true
	}
	switch p[2] {
	case "polls":
		if len(p) == 3 && r.Method == http.MethodPost {
			var in struct {
				Question string     `json:"question"`
				Options  []string   `json:"options"`
				ClosesAt *time.Time `json:"closes_at"`
			}
			if !a.decode(w, r, &in) {
				return true
			}
			in.Question = strings.TrimSpace(in.Question)
			for i := range in.Options {
				in.Options[i] = strings.TrimSpace(in.Options[i])
			}
			if !validPoll(in.Question, in.Options, in.ClosesAt, time.Now()) {
				a.fail(w, 400, "invalid_poll", "choose a question, 2–10 different options, and a future closing time within 90 days")
				return true
			}
			e = s.CreateChannelPoll(room, u.ID, in.Question, in.Options, in.ClosesAt)
		} else if len(p) == 5 && p[4] == "vote" && r.Method == http.MethodPut {
			var in struct {
				Option *int `json:"option"`
			}
			if !a.decode(w, r, &in) {
				return true
			}
			if in.Option != nil && (*in.Option < 0 || *in.Option > 9) {
				a.fail(w, 400, "invalid_vote", "choose a poll option")
				return true
			}
			e = s.VoteChannelPoll(room, u.ID, p[3], in.Option)
		} else if len(p) == 5 && p[4] == "close" && r.Method == http.MethodPost {
			e = s.CloseChannelPoll(room, u.ID, p[3])
		} else {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return true
		}
	case "scheduled-events":
		if len(p) == 3 && r.Method == http.MethodPost {
			var in struct {
				Title       string    `json:"title"`
				Description string    `json:"description"`
				StartsAt    time.Time `json:"starts_at"`
			}
			if !a.decode(w, r, &in) {
				return true
			}
			in.Title = strings.TrimSpace(in.Title)
			in.Description = strings.TrimSpace(in.Description)
			now := time.Now()
			if !activityText(in.Title, 1, 120) || !activityText(in.Description, 0, 1000) || !in.StartsAt.After(now) || in.StartsAt.After(now.Add(366*24*time.Hour)) {
				a.fail(w, 400, "invalid_event", "choose a title and future date within one year")
				return true
			}
			e = s.CreateScheduledEvent(room, u.ID, in.Title, in.Description, in.StartsAt)
		} else if len(p) == 5 && p[4] == "rsvp" && r.Method == http.MethodPut {
			var in struct {
				Response string `json:"response"`
			}
			if !a.decode(w, r, &in) {
				return true
			}
			if in.Response != "going" && in.Response != "maybe" && in.Response != "declined" {
				a.fail(w, 400, "invalid_rsvp", "choose going, maybe or declined")
				return true
			}
			e = s.RSVPScheduledEvent(room, u.ID, p[3], in.Response)
		} else if len(p) == 5 && p[4] == "cancel" && r.Method == http.MethodPost {
			e = s.CancelScheduledEvent(room, u.ID, p[3])
		} else {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return true
		}
	case "watch-together":
		if len(p) != 3 || r.Method != http.MethodPut {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return true
		}
		if !resolved.Permissions.JoinVoice {
			a.result(w, nil, ErrForbidden)
			return true
		}
		var in WatchTogetherCommand
		if !a.decode(w, r, &in) {
			return true
		}
		if !validWatchCommand(in) {
			a.fail(w, 400, "invalid_watch", "choose a video or valid playback command")
			return true
		}
		var v *WatchTogetherState
		v, e = s.ChangeWatchTogether(room, u.ID, in)
		if e == nil && in.Action != "heartbeat" {
			a.publishChannelActivity(room, "watch-together")
		}
		if errors.Is(e, ErrConflict) {
			a.fail(w, 409, "watch_changed", "playback changed; refresh its current state and try again")
		} else {
			a.result(w, map[string]any{"watch": v}, e)
		}
		return true
	case "media-assets":
		if len(p) == 3 && r.Method == http.MethodPost {
			var in struct {
				Name         string `json:"name"`
				Kind         string `json:"kind"`
				AttachmentID string `json:"attachment_id"`
				DurationMS   *int   `json:"duration_ms"`
			}
			if !a.decode(w, r, &in) {
				return true
			}
			in.Name = strings.TrimSpace(in.Name)
			if !activityText(in.Name, 1, 60) || !uuidPattern.MatchString(in.AttachmentID) || (in.Kind != "sticker" && in.Kind != "sound") || in.Kind == "sound" && (in.DurationMS == nil || *in.DurationMS < 1 || *in.DurationMS > 30000) {
				a.fail(w, 400, "invalid_asset", "choose a sticker image or a sound up to 30 seconds and give it a name")
				return true
			}
			e = s.CreateChannelMediaAsset(room, u.ID, in.AttachmentID, in.Name, in.Kind, in.DurationMS)
		} else if len(p) == 4 && r.Method == http.MethodDelete {
			e = s.DeleteChannelMediaAsset(room, u.ID, p[3])
		} else if len(p) == 5 && p[4] == "play" && r.Method == http.MethodPost {
			if !resolved.Permissions.JoinVoice {
				a.result(w, nil, ErrForbidden)
				return true
			}
			inCall := false
			for _, person := range a.Hub.callPresence(room) {
				if person.UserID == u.ID {
					inCall = true
					break
				}
			}
			if !inCall {
				a.fail(w, 403, "voice_required", "join voice to play a room sound")
				return true
			}
			if !a.limiter.allow("soundboard:"+u.ID, 4, 10*time.Second) || !a.limiter.allow("soundboard-room:"+room, 30, time.Minute) {
				a.fail(w, 429, "rate_limited", "give the soundboard a moment")
				return true
			}
			asset, err := s.ChannelMediaAsset(room, u.ID, p[3])
			if err != nil {
				a.result(w, nil, err)
				return true
			}
			if asset.Kind != "sound" {
				a.result(w, nil, ErrForbidden)
				return true
			}
			id, err := randomAttachmentID()
			if err != nil {
				a.result(w, nil, err)
				return true
			}
			payload, _ := json.Marshal(map[string]any{"room_id": room, "asset_id": asset.ID, "event_id": id, "duration_ms": asset.DurationMS, "played_at": time.Now().UTC()})
			a.Realtime.publishRoom(room, wire{Type: "soundboard.play", Payload: payload})
			a.json(w, 200, map[string]bool{"ok": true})
			return true
		} else if len(p) == 5 && p[4] == "send" && r.Method == http.MethodPost {
			var in struct {
				Nonce string `json:"nonce"`
			}
			if !a.decode(w, r, &in) {
				return true
			}
			if !uuidPattern.MatchString(in.Nonce) {
				a.fail(w, 400, "invalid_nonce", "provide a unique send ID")
				return true
			}
			m, created, err := s.SendStickerMessage(room, u.ID, p[3], in.Nonce)
			if err == nil && created {
				data, _ := json.Marshal(m)
				a.Hub.broadcast(room, nil, wire{Type: "chat.message", Payload: data})
				a.Realtime.publishRoom(room, wire{Type: "chat.message", Payload: data})
			}
			a.result(w, map[string]any{"message": m}, err)
			return true
		} else {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return true
		}
	default:
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return true
	}
	if e == nil {
		a.publishChannelActivity(room, p[2])
	}
	if errors.Is(e, ErrConflict) {
		switch p[2] {
		case "polls":
			a.fail(w, 409, "poll_closed", "this poll is closed")
		case "scheduled-events":
			a.fail(w, 409, "event_closed", "this event was cancelled or has already ended")
		case "media-assets":
			a.fail(w, 409, "asset_limit", "this channel has reached its limit of 100 stickers or sounds; remove one before adding another")
		default:
			a.result(w, map[string]bool{"ok": true}, e)
		}
	} else {
		a.result(w, map[string]bool{"ok": true}, e)
	}
	return true
}
func validWatchCommand(in WatchTogetherCommand) bool {
	if math.IsNaN(in.PositionSeconds) || math.IsInf(in.PositionSeconds, 0) || in.PositionSeconds < 0 || in.PositionSeconds > 604800 || in.Revision < 0 {
		return false
	}
	switch in.Action {
	case "start":
		return uuidPattern.MatchString(in.AttachmentID)
	case "play", "pause", "seek", "stop", "claim", "heartbeat":
		return true
	case "transfer":
		return uuidPattern.MatchString(in.HostID)
	default:
		return false
	}
}
