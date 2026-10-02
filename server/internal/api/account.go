package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

var ErrOwnedChannels = errors.New("transfer or delete owned channels first")

type sessionKey struct{}

func sessionFrom(r *http.Request) string {
	id, _ := r.Context().Value(sessionKey{}).(string)
	return id
}
func (a *API) account(w http.ResponseWriter, r *http.Request, u User, path string) {
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "account settings unavailable")
		return
	}
	current, err := a.Sessions.Resolve(r)
	if err != nil {
		a.fail(w, 401, "unauthenticated", "sign in required")
		return
	}
	if path == "me/sessions" && r.Method == http.MethodGet {
		items, err := store.ListDeviceSessions(r.Context(), u.ID, current.ID)
		a.result(w, map[string]any{"sessions": items}, err)
		return
	}
	if path == "me/account" && r.Method == http.MethodDelete {
		var in struct {
			Confirmation string `json:"confirmation"`
			Email        string `json:"email"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if in.Confirmation != "DELETE" || !strings.EqualFold(strings.TrimSpace(in.Email), u.Email) {
			a.fail(w, 400, "confirmation_required", "type DELETE and your account email to confirm")
			return
		}
		rooms, err := store.DeleteAccount(r.Context(), u.ID)
		if errors.Is(err, ErrOwnedChannels) {
			a.fail(w, 409, "owned_channels", "transfer ownership or delete your channels before deleting your account")
			return
		}
		if err != nil {
			a.result(w, nil, err)
			return
		}
		a.Sessions.Clear(w)
		a.Hub.disconnectUser(u.ID)
		a.Realtime.disconnectUser(u.ID)
		a.revokeSFU("", u.ID, "")
		data, _ := json.Marshal(map[string]string{"user_id": u.ID})
		for _, room := range rooms {
			a.Realtime.unsubscribeUser(room, u.ID)
			a.Realtime.publishRoom(room, wire{Type: "account.deleted", Payload: data})
			a.Realtime.publishRoom(room, wire{Type: "rooms.changed"})
		}
		// Deleted friendships are reconciled by all affected online peers without
		// exposing this account's former identity or deletion confirmation.
		a.Realtime.publishAll(wire{Type: "friends.changed"})
		a.json(w, 200, map[string]bool{"ok": true})
		return
	}
	others := path == "me/sessions/revoke-others" && r.Method == http.MethodPost
	target := strings.TrimPrefix(path, "me/sessions/")
	if !others && (r.Method != http.MethodDelete || !uuidPattern.MatchString(target)) {
		a.fail(w, 404, "not_found", "session action not found")
		return
	}
	if !a.limiter.allow("session-revoke:"+u.ID, 30, time.Minute) {
		a.fail(w, 429, "rate_limited", "too many session changes")
		return
	}
	if others {
		target = current.ID
	}
	ids, err := store.RevokeDeviceSessions(r.Context(), u.ID, target, others)
	if err != nil {
		a.result(w, nil, err)
		return
	}
	if !others && len(ids) == 0 {
		a.fail(w, 404, "not_found", "session not found")
		return
	}
	for _, id := range ids {
		a.Hub.disconnectSession(id)
		a.Realtime.disconnectSession(id)
		a.revokeSFU("", "", id)
		if id == current.ID {
			a.Sessions.Clear(w)
		}
	}
	a.json(w, 200, map[string]bool{"ok": true})
}

func (a *API) transferOwner(w http.ResponseWriter, r *http.Request, u User, room string) {
	if r.Method != http.MethodPost {
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	var in struct {
		UserID string `json:"user_id"`
	}
	if !a.decode(w, r, &in) {
		return
	}
	if !uuidPattern.MatchString(in.UserID) {
		a.fail(w, 400, "invalid_user", "choose a member")
		return
	}
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "account settings unavailable")
		return
	}
	err := store.TransferRoomOwner(r.Context(), room, u.ID, strings.ToLower(in.UserID))
	if err == nil {
		a.Realtime.publishRoom(room, wire{Type: "rooms.changed"})
		a.moderationChanged(room)
	}
	a.result(w, map[string]bool{"ok": true}, err)
}
