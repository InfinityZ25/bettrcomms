package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	AppURL, WorkOSClientID, WorkOSAPIKey, WorkOSRedirectURI string
	DevAuth                                                 bool
	ICEURLs                                                 []string
	TURNURLs                                                []string
	TURNSecret                                              string
	WebDist                                                 string
}
type API struct {
	Store          Store
	Sessions       Sessions
	Hub            *Hub
	Realtime       *RealtimeHub
	Config         Config
	AllowedOrigins []string
	HTTP           *http.Client
	states         map[string]time.Time
	stateMu        sync.Mutex
	limiter        *rateLimiter
}
type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func New(store Store, s Sessions, c Config) *API {
	origins := []string{}
	if app, e := url.Parse(c.AppURL); e == nil && app.Host != "" {
		origins = append(origins, app.Host)
	}
	if c.DevAuth {
		origins = append(origins, "localhost:*", "127.0.0.1:*")
	}
	return &API{Store: store, Sessions: s, Hub: NewHub(), Realtime: NewRealtimeHub(), Config: c, AllowedOrigins: origins, HTTP: http.DefaultClient, states: map[string]time.Time{}, limiter: newRateLimiter()}
}
func (a *API) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { a.json(w, 200, map[string]any{"status": "ok"}) })
	m.HandleFunc("GET /api/v1/config", func(w http.ResponseWriter, r *http.Request) {
		a.json(w, 200, map[string]any{"dev_auth": a.Config.DevAuth, "ice_servers": []map[string]any{{"urls": a.Config.ICEURLs}}})
	})
	m.Handle("GET /api/v1/auth/login", a.rate("auth", 10, time.Minute, http.HandlerFunc(a.login)))
	m.HandleFunc("GET /api/v1/auth/callback", a.callback)
	// devLogin is loopback-only and disabled unless DEV_AUTH=true (see devLogin), so it never
	// faces the abuse the production "auth" scope guards against. It gets its own, much larger
	// budget: the Playwright e2e suite logs in many users per run from the same loopback IP and
	// would otherwise exhaust the shared "auth" limit partway through, 429ing every test after it.
	m.Handle("POST /api/v1/auth/dev", a.rate("dev-auth", 1000, time.Minute, http.HandlerFunc(a.devLogin)))
	m.HandleFunc("POST /api/v1/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		uid, _ := a.Sessions.UserID(r)
		if e := a.Sessions.Revoke(r); e != nil {
			a.fail(w, 500, "internal", "could not revoke session")
			return
		}
		a.Sessions.Clear(w)
		if uid != "" {
			a.Hub.disconnectUser(uid)
			a.Realtime.disconnectUser(uid)
		}
		a.json(w, 200, map[string]bool{"ok": true})
	})
	m.Handle("/api/", a.auth(http.HandlerFunc(a.authed)))
	if a.Config.WebDist != "" {
		m.Handle("/", spaHandler(a.Config.WebDist))
	}
	return a.security(m)
}
func spaHandler(root string) http.Handler {
	files := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.NotFound(w, r)
			return
		}
		rel := strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), string(filepath.Separator))
		candidate := filepath.Join(root, rel)
		if info, e := os.Stat(candidate); e == nil && !info.IsDir() {
			assetPath := strings.TrimLeft(filepath.ToSlash(rel), "/")
			if strings.HasPrefix(assetPath, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			files.ServeHTTP(w, r)
			return
		}
		index := filepath.Join(root, "index.html")
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, index)
	})
}
func (a *API) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)")
		w.Header().Set("Cache-Control", "no-store")
		if a.Config.WebDist != "" {
			w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:*; worker-src 'self' blob:; img-src 'self' data: blob: https:; media-src 'self' blob: mediastream:")
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" && !a.sameOrigin(r) {
			a.fail(w, 403, "cross_site_request", "request origin is not allowed")
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (a *API) sameOrigin(r *http.Request) bool {
	if strings.EqualFold(r.Header.Get("Sec-Fetch-Site"), "cross-site") {
		return false
	}
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	want, e := url.Parse(a.Config.AppURL)
	if e != nil {
		return false
	}
	got, e := url.Parse(o)
	return e == nil && strings.EqualFold(got.Scheme, want.Scheme) && strings.EqualFold(got.Host, want.Host)
}

type userKey struct{}

func (a *API) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, e := a.Sessions.UserID(r)
		if e != nil {
			a.fail(w, 401, "unauthenticated", "sign in required")
			return
		}
		u, e := a.Store.UserByID(id)
		if e != nil {
			a.fail(w, 401, "invalid_session", "session user no longer exists")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey{}, u)))
	})
}
func userFrom(r *http.Request) User { return r.Context().Value(userKey{}).(User) }
func (a *API) authed(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r)
	p := strings.TrimPrefix(r.URL.Path, "/api/v1/")
	switch {
	case r.Method == "GET" && p == "me":
		a.json(w, 200, map[string]any{"user": u})
	case r.Method == "GET" && p == "ice":
		a.ice(w, u)
	case r.Method == "GET" && p == "call-presence":
		a.callPresence(w, u)
	case r.Method == "GET" && p == "events":
		a.realtimeWebsocket(w, r, u)
	case r.Method == "GET" && p == "users":
		if !a.limiter.allow("search:"+u.ID, 30, time.Minute) {
			a.fail(w, 429, "rate_limited", "too many searches")
			return
		}
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if len(q) < 2 {
			a.fail(w, 400, "invalid_query", "q must contain at least 2 characters")
			return
		}
		v, e := a.Store.FindUsers(q, u.ID)
		a.result(w, map[string]any{"users": v}, e)
	case p == "rooms":
		a.rooms(w, r, u)
	case p == "rooms/direct" && r.Method == "POST":
		var in struct {
			UserID string `json:"user_id"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		v, e := a.Store.CreateDirectRoom(u.ID, in.UserID)
		if e == nil {
			a.Realtime.subscribeUser(v.ID, u.ID)
			a.Realtime.subscribeUser(v.ID, in.UserID)
			a.Realtime.publishUser(u.ID, wire{Type: "rooms.changed"})
			a.Realtime.publishUser(in.UserID, wire{Type: "rooms.changed"})
		}
		a.resultStatus(w, map[string]any{"room": v}, e, 201)
	case strings.HasPrefix(p, "rooms/"):
		a.room(w, r, u, strings.Split(p, "/"))
	case p == "friends":
		a.friends(w, r, u)
	case p == "friends/requests":
		a.friendRequest(w, r, u)
	case strings.HasPrefix(p, "friends/requests/") && strings.HasSuffix(p, "/accept"):
		parts := strings.Split(p, "/")
		requestID := parts[2]
		_, requests, lookupErr := a.Store.ListFriends(u.ID)
		if lookupErr != nil {
			a.result(w, nil, lookupErr)
			return
		}
		var senderID string
		for _, request := range requests {
			if request.ID == requestID && request.Receiver.ID == u.ID {
				senderID = request.Sender.ID
				break
			}
		}
		e := a.Store.AcceptFriendRequest(requestID, u.ID)
		if e == nil {
			a.Realtime.publishUser(u.ID, wire{Type: "friends.changed"})
			if senderID != "" {
				a.Realtime.subscribeContacts(u.ID, senderID)
				a.Realtime.publishUser(senderID, wire{Type: "friends.changed"})
				a.Realtime.publishContactState(u.ID, senderID)
				a.Realtime.publishContactState(senderID, u.ID)
			}
		}
		a.result(w, map[string]bool{"ok": true}, e)
	case strings.HasPrefix(p, "friends/") && r.Method == "DELETE":
		otherID := strings.TrimPrefix(p, "friends/")
		e := a.Store.DeleteFriendship(u.ID, otherID)
		if e == nil {
			a.Realtime.publishUser(u.ID, wire{Type: "friends.changed"})
			a.Realtime.publishUser(otherID, wire{Type: "friends.changed"})
			a.Realtime.unsubscribeContacts(u.ID, otherID)
		}
		a.result(w, map[string]bool{"ok": true}, e)
	default:
		a.fail(w, 404, "not_found", "route not found")
	}
}

func (a *API) callPresence(w http.ResponseWriter, u User) {
	rooms, err := a.Store.ListRooms(u.ID)
	if err != nil {
		a.result(w, nil, err)
		return
	}
	presence := make([]RoomCallPresence, 0, len(rooms))
	for _, room := range rooms {
		presence = append(presence, RoomCallPresence{
			RoomID:       room.ID,
			Participants: a.Hub.callPresence(room.ID),
		})
	}
	a.json(w, http.StatusOK, map[string]any{"rooms": presence})
}
func (a *API) ice(w http.ResponseWriter, u User) {
	servers := []map[string]any{{"urls": a.Config.ICEURLs}}
	if a.Config.TURNSecret != "" && len(a.Config.TURNURLs) > 0 {
		expires := time.Now().Add(10 * time.Minute).Unix()
		username := fmt.Sprintf("%d:%s", expires, u.ID)
		mac := hmac.New(sha1.New, []byte(a.Config.TURNSecret))
		mac.Write([]byte(username))
		servers = append(servers, map[string]any{"urls": a.Config.TURNURLs, "username": username, "credential": base64.StdEncoding.EncodeToString(mac.Sum(nil)), "credential_type": "password"})
	}
	a.json(w, 200, map[string]any{"ice_servers": servers, "ttl_seconds": 600})
}
func (a *API) rooms(w http.ResponseWriter, r *http.Request, u User) {
	if r.Method == "GET" {
		v, e := a.Store.ListRooms(u.ID)
		a.result(w, map[string]any{"rooms": v}, e)
		return
	}
	if r.Method != "POST" {
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !a.decode(w, r, &in) || len(strings.TrimSpace(in.Name)) < 1 || len(in.Name) > 100 {
		a.fail(w, 400, "invalid_name", "name must be 1-100 characters")
		return
	}
	v, e := a.Store.CreateRoom(u.ID, strings.TrimSpace(in.Name))
	if e == nil {
		a.Realtime.subscribeUser(v.ID, u.ID)
		a.Realtime.publishUser(u.ID, wire{Type: "rooms.changed"})
	}
	a.resultStatus(w, map[string]any{"room": v}, e, 201)
}
func (a *API) room(w http.ResponseWriter, r *http.Request, u User, p []string) {
	if len(p) < 2 {
		return
	}
	rid := p[1]
	if len(p) == 3 && p[2] == "ws" {
		a.websocket(w, r, u, rid)
		return
	}
	if len(p) == 3 && p[2] == "voice-relay" {
		a.voiceRelay(w, r, u, rid)
		return
	}
	if _, e := a.Store.RoomForMember(rid, u.ID); e != nil {
		a.fail(w, 403, "not_a_member", "room membership required")
		return
	}
	if len(p) == 2 && r.Method == "GET" {
		v, e := a.Store.RoomForMember(rid, u.ID)
		a.result(w, map[string]any{"room": v}, e)
		return
	}
	if len(p) == 2 && r.Method == "PATCH" {
		var in struct {
			Name string `json:"name"`
		}
		if !a.decode(w, r, &in) || len(strings.TrimSpace(in.Name)) < 1 || len(in.Name) > 100 {
			a.fail(w, 400, "invalid_name", "name must be 1-100 characters")
			return
		}
		v, e := a.Store.RenameRoom(rid, u.ID, strings.TrimSpace(in.Name))
		if e == nil {
			a.Realtime.publishRoom(rid, wire{Type: "rooms.changed"})
		}
		a.result(w, map[string]any{"room": v}, e)
		return
	}
	if len(p) == 2 && r.Method == "DELETE" {
		e := a.Store.DeleteRoom(rid, u.ID)
		if e == nil {
			a.Realtime.publishRoom(rid, wire{Type: "rooms.changed"})
			a.Realtime.unsubscribeRoom(rid)
			a.Hub.disconnectRoom(rid)
		}
		a.result(w, map[string]bool{"ok": true}, e)
		return
	}
	if len(p) == 3 && p[2] == "members" && r.Method == "GET" {
		v, e := a.Store.ListRoomMembers(rid)
		a.result(w, map[string]any{"members": v}, e)
		return
	}
	if len(p) == 3 && p[2] == "messages" {
		if r.Method == "GET" {
			limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			if limit < 1 || limit > 100 {
				limit = 50
			}
			before := time.Now().Add(time.Second)
			if q := r.URL.Query().Get("before"); q != "" {
				var e error
				before, e = time.Parse(time.RFC3339Nano, q)
				if e != nil {
					a.fail(w, 400, "invalid_before", "before must be RFC3339")
					return
				}
			}
			v, e := a.Store.ListMessages(rid, before, limit)
			a.result(w, map[string]any{"messages": v}, e)
			return
		}
		var in struct {
			Body string `json:"body"`
		}
		if !a.decode(w, r, &in) || len(strings.TrimSpace(in.Body)) < 1 || len(in.Body) > 4000 {
			a.fail(w, 400, "invalid_body", "body must be 1-4000 characters")
			return
		}
		v, e := a.Store.CreateMessage(rid, u.ID, strings.TrimSpace(in.Body))
		if e == nil {
			b, _ := json.Marshal(v)
			a.Hub.broadcast(rid, nil, wire{Type: "chat.message", From: u.ID, Payload: b})
			a.Realtime.publishRoom(rid, wire{Type: "chat.message", From: u.ID, Payload: b})
		}
		a.resultStatus(w, map[string]any{"message": v}, e, 201)
		return
	}
	if len(p) == 3 && p[2] == "members" && r.Method == "POST" {
		var in struct {
			UserID string `json:"user_id"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		e := a.Store.AddRoomMember(rid, u.ID, in.UserID)
		if e == nil {
			a.Realtime.subscribeUser(rid, in.UserID)
			a.Realtime.publishRoom(rid, wire{Type: "rooms.changed"})
		}
		a.resultStatus(w, map[string]bool{"ok": true}, e, 201)
		return
	}
	if len(p) == 4 && p[2] == "members" && r.Method == "DELETE" {
		target := p[3]
		e := a.Store.RemoveRoomMember(rid, u.ID, target)
		if e == nil {
			a.Realtime.publishRoom(rid, wire{Type: "rooms.changed"})
			a.Realtime.unsubscribeUser(rid, target)
			a.Hub.disconnectRoomUser(rid, target)
		}
		a.result(w, map[string]bool{"ok": true}, e)
		return
	}
	a.fail(w, 404, "not_found", "route not found")
}
func (a *API) friends(w http.ResponseWriter, r *http.Request, u User) {
	if r.Method != "GET" {
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	f, q, e := a.Store.ListFriends(u.ID)
	a.result(w, map[string]any{"friends": f, "requests": q}, e)
}
func (a *API) friendRequest(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		UserID string `json:"user_id"`
	}
	if !a.decode(w, r, &in) || in.UserID == u.ID {
		a.fail(w, 400, "invalid_user", "choose another user")
		return
	}
	v, e := a.Store.CreateFriendRequest(u.ID, in.UserID)
	if e == nil {
		a.Realtime.publishUser(u.ID, wire{Type: "friends.changed"})
		a.Realtime.publishUser(in.UserID, wire{Type: "friends.changed"})
	}
	a.resultStatus(w, map[string]any{"request": v}, e, 201)
}
func (a *API) login(w http.ResponseWriter, r *http.Request) {
	if a.Config.WorkOSClientID == "" || a.Config.WorkOSRedirectURI == "" {
		a.fail(w, 503, "auth_not_configured", "WorkOS authentication is not configured")
		return
	}
	app, e := url.Parse(a.Config.AppURL)
	requestHost := r.Host
	if host, _, splitErr := net.SplitHostPort(r.Host); splitErr == nil {
		requestHost = host
	}
	if app != nil && app.Hostname() != "" && !strings.EqualFold(requestHost, app.Hostname()) {
		canonical := *app
		canonical.Path = "/api/v1/auth/login"
		canonical.RawQuery = ""
		canonical.Fragment = ""
		http.Redirect(w, r, canonical.String(), http.StatusTemporaryRedirect)
		return
	}
	state, e := randomToken()
	if e != nil {
		a.fail(w, 500, "internal", "could not begin login")
		return
	}
	a.stateMu.Lock()
	for token, expires := range a.states {
		if time.Now().After(expires) {
			delete(a.states, token)
		}
	}
	a.states[state] = time.Now().Add(10 * time.Minute)
	a.stateMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "bettercomms_oauth_state", Value: state, Path: "/api/v1/auth/callback", MaxAge: 600, HttpOnly: true, Secure: a.Sessions.Secure, SameSite: http.SameSiteLaxMode})
	q := url.Values{"client_id": {a.Config.WorkOSClientID}, "redirect_uri": {a.Config.WorkOSRedirectURI}, "response_type": {"code"}, "provider": {"authkit"}, "state": {state}}
	http.Redirect(w, r, "https://api.workos.com/user_management/authorize?"+q.Encode(), http.StatusFound)
}
func (a *API) callback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	stateCookie, cookieErr := r.Cookie("bettercomms_oauth_state")
	a.stateMu.Lock()
	exp, ok := a.states[state]
	delete(a.states, state)
	a.stateMu.Unlock()
	if !ok || cookieErr != nil || subtle.ConstantTimeCompare([]byte(state), []byte(stateCookie.Value)) != 1 || time.Now().After(exp) {
		a.fail(w, 400, "invalid_state", "login state is invalid or expired")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "bettercomms_oauth_state", Path: "/api/v1/auth/callback", MaxAge: -1, HttpOnly: true, Secure: a.Sessions.Secure, SameSite: http.SameSiteLaxMode})
	if a.Config.WorkOSClientID == "" || a.Config.WorkOSAPIKey == "" {
		a.fail(w, 503, "auth_not_configured", "WorkOS authentication is not configured")
		return
	}
	body, _ := json.Marshal(map[string]string{"client_id": a.Config.WorkOSClientID, "client_secret": a.Config.WorkOSAPIKey, "grant_type": "authorization_code", "code": r.URL.Query().Get("code")})
	req, _ := http.NewRequestWithContext(r.Context(), "POST", "https://api.workos.com/user_management/authenticate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, e := a.HTTP.Do(req)
	if e != nil {
		a.fail(w, 502, "auth_exchange_failed", "authentication provider unavailable")
		return
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		a.fail(w, 401, "auth_exchange_failed", "authorization code was rejected")
		return
	}
	var out struct {
		User struct {
			ID                string  `json:"id"`
			Email             string  `json:"email"`
			FirstName         string  `json:"first_name"`
			LastName          string  `json:"last_name"`
			ProfilePictureURL *string `json:"profile_picture_url"`
		} `json:"user"`
	}
	if e = json.NewDecoder(res.Body).Decode(&out); e != nil {
		a.fail(w, 502, "invalid_auth_response", "authentication provider response was invalid")
		return
	}
	if out.User.ID == "" || !strings.Contains(out.User.Email, "@") {
		a.fail(w, 502, "invalid_auth_response", "authentication provider response omitted the user identity")
		return
	}
	name := strings.TrimSpace(out.User.FirstName + " " + out.User.LastName)
	if name == "" {
		name = out.User.Email
	}
	u, e := a.Store.UpsertUser(out.User.ID, out.User.Email, name, out.User.ProfilePictureURL)
	if e != nil {
		a.fail(w, 500, "internal", "could not save user")
		return
	}
	if e = a.Sessions.Set(r, w, u.ID); e != nil {
		a.fail(w, 500, "internal", "could not create session")
		return
	}
	http.Redirect(w, r, a.Config.AppURL, http.StatusFound)
}
func (a *API) devLogin(w http.ResponseWriter, r *http.Request) {
	host, _, _ := net.SplitHostPort(r.Host)
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if !a.Config.DevAuth || !(host == "localhost" || net.ParseIP(host).IsLoopback()) || !net.ParseIP(ip).IsLoopback() {
		a.fail(w, 404, "not_found", "route not found")
		return
	}
	var in struct{ Email, Name string }
	if !a.decode(w, r, &in) {
		return
	}
	if !strings.Contains(in.Email, "@") || strings.TrimSpace(in.Name) == "" {
		a.fail(w, 400, "invalid_user", "valid email and name required")
		return
	}
	u, e := a.Store.UpsertDevUser(strings.ToLower(in.Email), strings.TrimSpace(in.Name))
	if e == nil {
		if e = a.Sessions.Set(r, w, u.ID); e != nil {
			a.fail(w, 500, "internal", "could not create session")
			return
		}
	}
	a.result(w, map[string]any{"user": u}, e)
}
func (a *API) decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		a.fail(w, 415, "content_type", "application/json required")
		return false
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		a.fail(w, 400, "invalid_json", "invalid request body")
		return false
	}
	return true
}
func (a *API) json(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func (a *API) fail(w http.ResponseWriter, status int, code, msg string) {
	a.json(w, status, map[string]any{"error": apiError{Code: code, Message: msg}})
}
func (a *API) result(w http.ResponseWriter, v any, e error) { a.resultStatus(w, v, e, 200) }
func (a *API) resultStatus(w http.ResponseWriter, v any, e error, status int) {
	if e == nil {
		a.json(w, status, v)
		return
	}
	if errors.Is(e, ErrNotFound) {
		a.fail(w, 404, "not_found", "resource not found")
		return
	}
	if errors.Is(e, ErrForbidden) {
		a.fail(w, 403, "forbidden", "you do not have permission to perform this action")
		return
	}
	a.fail(w, 500, "internal", fmt.Sprintf("operation failed"))
}
