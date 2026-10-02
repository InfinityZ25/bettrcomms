package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

func (a *API) privacy(w http.ResponseWriter, r *http.Request, user User, path string) {
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "privacy settings unavailable")
		return
	}
	if path == "privacy" {
		switch r.Method {
		case http.MethodGet:
			allowed, blocked, err := store.DMPrivacy(user.ID)
			a.result(w, map[string]any{"allow_dm_requests": allowed, "blocked": blocked}, err)
		case http.MethodPut:
			var in struct {
				AllowDMRequests bool `json:"allow_dm_requests"`
			}
			if !a.decode(w, r, &in) {
				return
			}
			a.result(w, map[string]bool{"ok": true}, store.SetDMRequestsAllowed(user.ID, in.AllowDMRequests))
		default:
			a.fail(w, 405, "method_not_allowed", "method not allowed")
		}
		return
	}
	target := strings.ToLower(strings.TrimPrefix(path, "privacy/blocks/"))
	if !uuidPattern.MatchString(target) || target == user.ID {
		a.fail(w, 400, "invalid_user", "choose another user")
		return
	}
	switch r.Method {
	case http.MethodPost:
		room, groups, err := store.BlockUserWithGroups(user.ID, target)
		if err != nil {
			a.result(w, nil, err)
			return
		}
		a.Realtime.unsubscribeContacts(user.ID, target)
		for _, pair := range [][2]string{{user.ID, target}, {target, user.ID}} {
			payload, _ := json.Marshal(map[string]any{"user_id": pair[1], "online": false})
			a.Realtime.publishUser(pair[0], wire{Type: "user.presence", Payload: payload})
			a.Realtime.publishUser(pair[0], wire{Type: "friends.changed"})
			a.Realtime.publishUser(pair[0], wire{Type: "rooms.changed"})
		}
		if room != "" {
			a.Realtime.unsubscribeUser(room, user.ID)
			a.Realtime.unsubscribeUser(room, target)
			a.Hub.disconnectRoomUser(room, user.ID)
			a.Hub.disconnectRoomUser(room, target)
			a.revokeSFU(room, user.ID, "")
			a.revokeSFU(room, target, "")
		}
		for _, group := range groups {
			a.Realtime.publishRoom(group, wire{Type: "rooms.changed"})
			a.Realtime.unsubscribeUser(group, user.ID)
			a.Hub.disconnectRoomUser(group, user.ID)
			a.revokeSFU(group, user.ID, "")
		}
		a.result(w, map[string]bool{"ok": true}, nil)
	case http.MethodDelete:
		err := store.UnblockUser(user.ID, target)
		if err == nil {
			a.Realtime.publishUser(user.ID, wire{Type: "privacy.changed"})
		}
		a.result(w, map[string]bool{"ok": true}, err)
	default:
		a.fail(w, 405, "method_not_allowed", "method not allowed")
	}
}

func (a *API) dmRequests(w http.ResponseWriter, r *http.Request, user User, path string) {
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "message requests unavailable")
		return
	}
	if path == "dm-requests" {
		if r.Method == http.MethodGet {
			items, err := store.ListDMRequests(user.ID)
			a.result(w, map[string]any{"requests": items}, err)
			return
		}
		if r.Method != http.MethodPost {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return
		}
		if !a.limiter.allow("dm-request:"+user.ID, 5, time.Hour) {
			w.Header().Set("Retry-After", "3600")
			a.fail(w, 429, "rate_limited", "too many message requests")
			return
		}
		var in struct {
			UserID string `json:"user_id"`
			Body   string `json:"body"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		in.Body = strings.TrimSpace(in.Body)
		if !uuidPattern.MatchString(in.UserID) || in.UserID == user.ID || utf8.RuneCountInString(in.Body) < 1 || utf8.RuneCountInString(in.Body) > 500 {
			a.fail(w, 400, "invalid_request", "choose a person and a message up to 500 characters")
			return
		}
		item, err := store.CreateDMRequest(user.ID, in.UserID, in.Body)
		if err == nil {
			a.Realtime.publishUser(in.UserID, wire{Type: "dm.requests.changed"})
		}
		a.resultStatus(w, map[string]any{"request": item}, err, 201)
		return
	}
	parts := strings.Split(strings.TrimPrefix(path, "dm-requests/"), "/")
	if len(parts) != 2 || !uuidPattern.MatchString(parts[0]) || r.Method != http.MethodPost {
		a.fail(w, 404, "not_found", "request not found")
		return
	}
	if parts[1] == "accept" {
		room, message, err := store.AcceptDMRequest(parts[0], user.ID)
		if err != nil {
			a.result(w, nil, err)
			return
		}
		a.Realtime.subscribeUser(room.ID, user.ID)
		a.Realtime.subscribeUser(room.ID, message.Author.ID)
		for _, id := range []string{user.ID, message.Author.ID} {
			a.Realtime.publishUser(id, wire{Type: "rooms.changed"})
			a.Realtime.publishUser(id, wire{Type: "dm.requests.changed"})
		}
		payload, _ := json.Marshal(message)
		a.Hub.broadcast(room.ID, nil, wire{Type: "chat.message", From: message.Author.ID, Payload: payload})
		a.Realtime.publishRoom(room.ID, wire{Type: "chat.message", From: message.Author.ID, Payload: payload})
		a.json(w, 200, map[string]any{"room": room})
		return
	}
	if parts[1] == "decline" {
		other, err := store.DeclineDMRequest(parts[0], user.ID)
		if err == nil {
			a.Realtime.publishUser(user.ID, wire{Type: "dm.requests.changed"})
			a.Realtime.publishUser(other, wire{Type: "dm.requests.changed"})
		}
		a.result(w, map[string]bool{"ok": true}, err)
		return
	}
	a.fail(w, 404, "not_found", "request not found")
}
