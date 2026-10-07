package api

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

func (a *API) createGroup(w http.ResponseWriter, r *http.Request, u User) {
	store, ok := a.Store.(SocialStore)
	if !ok {
		a.fail(w, 503, "unavailable", "group conversations unavailable")
		return
	}
	var in struct {
		Name    string   `json:"name"`
		UserIDs []string `json:"user_ids"`
	}
	if !a.decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if utf8.RuneCountInString(in.Name) < 1 || utf8.RuneCountInString(in.Name) > 100 || len(in.UserIDs) < 1 || len(in.UserIDs) >= groupMemberLimit {
		a.fail(w, 400, "invalid_group", "choose a name and one to nine friends")
		return
	}
	seen := map[string]bool{u.ID: true}
	for index, value := range in.UserIDs {
		id := strings.ToLower(value)
		in.UserIDs[index] = id
		if !uuidPattern.MatchString(id) || seen[id] {
			a.fail(w, 400, "invalid_group", "choose distinct friends")
			return
		}
		seen[id] = true
	}
	if !a.limiter.allow("group-create:"+u.ID, 30, time.Hour) {
		a.fail(w, 429, "rate_limited", "too many groups")
		return
	}
	room, err := store.CreateGroup(u.ID, in.Name, in.UserIDs)
	if err == nil {
		for id := range seen {
			a.Realtime.subscribeUser(room.ID, id)
			a.Realtime.publishUser(id, wire{Type: "rooms.changed"})
		}
	}
	a.socialResult(w, map[string]any{"room": room}, err, 201)
}

func (a *API) socialResult(w http.ResponseWriter, v any, err error, status int) {
	if errors.Is(err, ErrInviteLimit) {
		a.fail(w, 409, "invite_limit", "revoke an existing invitation before creating more; each room allows 20 active links")
		return
	}
	if errors.Is(err, ErrGroupFull) {
		a.fail(w, 409, "group_full", "group conversations allow up to ten people")
		return
	}
	if errors.Is(err, ErrInviteUnavailable) {
		a.fail(w, 404, "invite_unavailable", "invitation expired, was revoked or has no remaining uses")
		return
	}
	a.resultStatus(w, v, err, status)
}

func (a *API) roomInvites(w http.ResponseWriter, r *http.Request, u User, p []string) {
	store, ok := a.Store.(SocialStore)
	if !ok {
		a.fail(w, 503, "unavailable", "invitations unavailable")
		return
	}
	if len(p) == 4 && r.Method == http.MethodDelete {
		if !uuidPattern.MatchString(p[3]) {
			a.fail(w, 404, "not_found", "invitation not found")
			return
		}
		a.result(w, map[string]bool{"ok": true}, store.RevokeInvite(p[1], u.ID, p[3]))
		return
	}
	if len(p) != 3 {
		a.fail(w, 404, "not_found", "route not found")
		return
	}
	if r.Method == http.MethodGet {
		items, err := store.ListInvites(p[1], u.ID)
		a.result(w, map[string]any{"invites": items}, err)
		return
	}
	if r.Method != http.MethodPost {
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	if !a.limiter.allow("invite-create:"+u.ID, 30, time.Hour) {
		a.fail(w, 429, "rate_limited", "too many invitations")
		return
	}
	var in struct {
		ExpiresInSeconds *int64 `json:"expires_in_seconds"`
		MaxUses          *int   `json:"max_uses"`
	}
	if !a.decode(w, r, &in) {
		return
	}
	seconds := int64(7 * 24 * 60 * 60)
	max := 100
	if in.ExpiresInSeconds != nil {
		seconds = *in.ExpiresInSeconds
	}
	if in.MaxUses != nil {
		max = *in.MaxUses
	}
	if seconds < 0 || seconds > 30*24*60*60 || max < 0 || max > 1000 {
		a.fail(w, 400, "invalid_invite", "expiry must be up to 30 days and uses up to 1000; zero means unlimited")
		return
	}
	var expires *time.Time
	if seconds > 0 {
		value := time.Now().Add(time.Duration(seconds) * time.Second)
		expires = &value
	}
	token, err := randomToken()
	if err != nil {
		a.result(w, nil, err)
		return
	}
	item, err := store.CreateInvite(p[1], u.ID, token, expires, max)
	base, parseErr := url.Parse(a.Config.AppURL)
	if parseErr != nil || base.Host == "" {
		a.fail(w, 503, "unavailable", "application URL unavailable")
		return
	}
	base.RawQuery = ""
	base.Fragment = "/?invite=" + token
	a.socialResult(w, map[string]any{"invite": item, "token": token, "url": base.String()}, err, 201)
}

func (a *API) invite(w http.ResponseWriter, r *http.Request, u User, p []string) {
	store, ok := a.Store.(SocialStore)
	if !ok {
		a.fail(w, 503, "unavailable", "invitations unavailable")
		return
	}
	if len(p) < 2 || len(p[1]) != 43 {
		a.fail(w, 404, "invite_unavailable", "invitation unavailable")
		return
	}
	if !a.limiter.allow("invite-open:"+u.ID, 60, time.Minute) {
		a.fail(w, 429, "rate_limited", "too many invitation attempts")
		return
	}
	if len(p) == 2 && r.Method == http.MethodGet {
		preview, err := store.PreviewInvite(p[1], u.ID)
		a.socialResult(w, map[string]any{"invite": preview}, err, 200)
		return
	}
	if len(p) == 3 && p[2] == "join" && r.Method == http.MethodPost {
		room, added, err := store.RedeemInvite(p[1], u.ID)
		if err == nil {
			if pg, ok := a.Store.(*PostgresStore); ok && room.CommunityID != nil {
				if community, lookupErr := pg.CommunityForMember(*room.CommunityID, u.ID); lookupErr == nil {
					a.communityMembershipChanged(community, u.ID, true)
				}
			} else {
				a.Realtime.subscribeUser(room.ID, u.ID)
				if added {
					a.Realtime.publishRoom(room.ID, wire{Type: "rooms.changed"})
				}
			}
		}
		a.socialResult(w, map[string]any{"room": room}, err, 200)
		return
	}
	a.fail(w, 404, "not_found", "route not found")
}
