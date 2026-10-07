package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

func (a *API) moderation(w http.ResponseWriter, r *http.Request, u User, p []string) {
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "moderation unavailable")
		return
	}
	room := strings.ToLower(p[1])
	if len(p) == 3 && r.Method == http.MethodGet {
		after := r.URL.Query().Get("bans_after")
		if after != "" && !uuidPattern.MatchString(after) {
			a.fail(w, 400, "invalid_cursor", "ban cursor must be a user UUID")
			return
		}
		state, err := store.PostingState(room, u.ID)
		if err != nil {
			a.result(w, nil, err)
			return
		}
		info, ownerErr := store.RoomForMember(room, u.ID)
		if ownerErr != nil {
			a.result(w, nil, ownerErr)
			return
		}
		var bans []RoomBan
		var audit []ModerationAudit
		next := ""
		if info.Kind == "channel" && info.Permissions.Moderate {
			var err error
			bans, audit, next, err = store.RoomModeration(room, u.ID, after)
			if err != nil {
				a.result(w, nil, err)
				return
			}
		}
		a.json(w, 200, map[string]any{"state": state, "bans": bans, "bans_next": next, "audit": audit})
		return
	}
	if !a.limiter.allow("room-moderate:"+u.ID, 30, time.Minute) {
		a.fail(w, 429, "rate_limited", "too many moderation actions")
		return
	}
	if len(p) == 4 && p[3] == "slow-mode" && r.Method == http.MethodPut {
		var in struct {
			Seconds int `json:"seconds"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if in.Seconds < 0 || in.Seconds > 3600 {
			a.fail(w, 400, "invalid_duration", "slow mode must be 0–3600 seconds")
			return
		}
		err := store.SetSlowMode(room, u.ID, in.Seconds)
		if err == nil {
			a.moderationChanged(room)
		}
		a.result(w, map[string]bool{"ok": true}, err)
		return
	}
	if len(p) != 5 || (p[3] != "bans" && p[3] != "timeouts") || !uuidPattern.MatchString(p[4]) {
		a.fail(w, 404, "not_found", "moderation action not found")
		return
	}
	target := strings.ToLower(p[4])
	action, reason, duration := "", "", 0
	if r.Method == http.MethodDelete {
		if p[3] == "bans" {
			action = "unban"
		} else {
			action = "clear_timeout"
		}
	} else if r.Method == http.MethodPut {
		var in struct {
			Reason  string `json:"reason"`
			Seconds int    `json:"seconds"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		reason = strings.TrimSpace(in.Reason)
		if n := utf8.RuneCountInString(reason); n < 3 || n > 500 {
			a.fail(w, 400, "invalid_reason", "reason must be 3–500 characters")
			return
		}
		if p[3] == "bans" {
			action = "ban"
		} else {
			action = "timeout"
			duration = in.Seconds
			if duration < 1 || duration > 28*86400 {
				a.fail(w, 400, "invalid_duration", "timeout must be 1 second to 28 days")
				return
			}
		}
	} else {
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	err := store.ModerateMember(room, u.ID, target, action, reason, duration)
	if err == nil {
		if info, lookupErr := store.RoomForMember(room, u.ID); lookupErr == nil && info.CommunityID != nil {
			if community, lookupErr := store.CommunityForMember(*info.CommunityID, u.ID); lookupErr == nil {
				if action == "ban" {
					a.communityMembershipChanged(community, target, false)
				} else {
					a.communityChanged(community)
				}
			}
		} else {
			a.moderationChanged(room)
		}
	}
	a.result(w, map[string]bool{"ok": true}, err)
}
func (a *API) moderationChanged(room string) {
	payload, _ := json.Marshal(map[string]string{"room_id": room})
	a.Realtime.publishRoom(room, wire{Type: "room.moderation", Payload: payload})
	a.Realtime.publishRoom(room, wire{Type: "rooms.changed"})
}
