package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testStore struct {
	Store
	user    User
	roomErr error
}

type presenceTestStore struct {
	testStore
	rooms   []Room
	friends []User
}

func (s presenceTestStore) ListRooms(string) ([]Room, error) { return s.rooms, nil }
func (s presenceTestStore) ListFriends(string) ([]User, []FriendRequest, error) {
	return s.friends, nil, nil
}

type memorySessionStore struct {
	users   map[string]string
	expires map[string]time.Time
}

func newTestSessions(secure bool) Sessions {
	return Sessions{Store: &memorySessionStore{users: map[string]string{}, expires: map[string]time.Time{}}, Secure: secure}
}
func key(h []byte) string { return string(h) }
func (s *memorySessionStore) CreateSession(_ context.Context, h []byte, u string, e time.Time) error {
	s.users[key(h)] = u
	s.expires[key(h)] = e
	return nil
}
func (s *memorySessionStore) SessionUser(_ context.Context, h []byte, now time.Time) (string, error) {
	u, ok := s.users[key(h)]
	if !ok || !s.expires[key(h)].After(now) {
		return "", ErrNotFound
	}
	return u, nil
}
func (s *memorySessionStore) DeleteSession(_ context.Context, h []byte) error {
	delete(s.users, key(h))
	delete(s.expires, key(h))
	return nil
}
func (s *memorySessionStore) DeleteExpiredSessions(_ context.Context, now time.Time) error {
	for k, e := range s.expires {
		if !e.After(now) {
			delete(s.expires, k)
			delete(s.users, k)
		}
	}
	return nil
}

func (s testStore) UserByID(string) (User, error)              { return s.user, nil }
func (s testStore) RoomForMember(string, string) (Room, error) { return Room{}, s.roomErr }

func TestSessionCookieSecurityAndTamperDetection(t *testing.T) {
	s := newTestSessions(true)
	w := httptest.NewRecorder()
	if e := s.Set(httptest.NewRequest("GET", "/", nil), w, "user-1"); e != nil {
		t.Fatal(e)
	}
	c := w.Result().Cookies()[0]
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode {
		t.Fatalf("insecure cookie attributes: %#v", c)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(c)
	id, e := s.UserID(r)
	if e != nil || id != "user-1" {
		t.Fatalf("valid session rejected: %q %v", id, e)
	}
	replacement := byte('x')
	if c.Value[0] == replacement {
		replacement = 'y'
	}
	c.Value = string(replacement) + c.Value[1:]
	r = httptest.NewRequest("GET", "/", nil)
	r.AddCookie(c)
	if _, e = s.UserID(r); e == nil {
		t.Fatal("tampered session accepted")
	}
}

func TestCallPresenceReturnsOnlyAuthenticatedUsersRooms(t *testing.T) {
	u := User{ID: "user-1", Email: "alice@example.test", Name: "Alice"}
	sessions := newTestSessions(false)
	store := presenceTestStore{testStore: testStore{user: u}, rooms: []Room{{ID: "allowed", Name: "Allowed"}}}
	a := New(store, sessions, Config{})
	a.Hub.add("allowed", &client{user: "friend", name: "Friend", send: make(chan wire, 1)})
	a.Hub.add("private", &client{user: "outsider", name: "Outsider", send: make(chan wire, 1)})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/call-presence", nil)
	cookieRecorder := httptest.NewRecorder()
	if err := sessions.Set(request, cookieRecorder, u.ID); err != nil {
		t.Fatal(err)
	}
	request.AddCookie(cookieRecorder.Result().Cookies()[0])
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("presence status %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		Rooms []RoomCallPresence `json:"rooms"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Rooms) != 1 || body.Rooms[0].RoomID != "allowed" || len(body.Rooms[0].Participants) != 1 || body.Rooms[0].Participants[0].UserID != "friend" {
		t.Fatalf("unexpected scoped presence: %#v", body.Rooms)
	}
	if strings.Contains(response.Body.String(), "outsider") || strings.Contains(response.Body.String(), "private") {
		t.Fatalf("unauthorized room presence leaked: %s", response.Body.String())
	}
}

func TestAuthenticatedRoomWebSocketRequiresMembership(t *testing.T) {
	u := User{ID: "user-1", Email: "a@example.test", Name: "A"}
	s := newTestSessions(false)
	a := New(testStore{user: u, roomErr: ErrNotFound}, s, Config{})
	w0 := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "http://localhost/api/v1/rooms/room-1/ws", nil)
	if e := s.Set(req, w0, u.ID); e != nil {
		t.Fatal(e)
	}
	cookie := w0.Result().Cookies()[0]
	req.RemoteAddr = "127.0.0.1:1234"
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestLogoutRevokesSession(t *testing.T) {
	s := newTestSessions(false)
	issue := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	if e := s.Set(issue, w, "user-1"); e != nil {
		t.Fatal(e)
	}
	c := w.Result().Cookies()[0]
	r := httptest.NewRequest("POST", "/", nil)
	r.AddCookie(c)
	if e := s.Revoke(r); e != nil {
		t.Fatal(e)
	}
	check := httptest.NewRequest("GET", "/", nil)
	check.AddCookie(c)
	if _, e := s.UserID(check); e == nil {
		t.Fatal("revoked session accepted")
	}
}

func TestDevAuthIsLoopbackOnly(t *testing.T) {
	a := New(testStore{}, newTestSessions(false), Config{DevAuth: true})
	req := httptest.NewRequest("POST", "http://example.com/api/v1/auth/dev", strings.NewReader(`{"email":"a@example.test","name":"A"}`))
	req.Host = "example.com"
	req.RemoteAddr = "203.0.113.5:1234"
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("non-loopback dev auth status=%d", w.Code)
	}
}

func TestMutationRejectsCrossSiteOrigin(t *testing.T) {
	a := New(testStore{}, newTestSessions(false), Config{AppURL: "http://localhost:5173"})
	req := httptest.NewRequest("POST", "http://localhost/api/v1/auth/logout", nil)
	req.Header.Set("Origin", "https://attacker.example")
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status=%d", w.Code)
	}
}

func TestProductionStaticAssetsUseCSPAndContentAwareCaching(t *testing.T) {
	dist := t.TempDir()
	if err := os.Mkdir(filepath.Join(dist, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		"index.html":             "<!doctype html><div id=app></div>",
		"assets/app-abcd1234.js": "console.log('app')",
	} {
		if err := os.WriteFile(filepath.Join(dist, filepath.FromSlash(path)), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a := New(testStore{}, newTestSessions(true), Config{AppURL: "https://chat.example", WebDist: dist})
	for _, tc := range []struct {
		path, cache string
	}{
		{path: "/", cache: "no-cache"},
		{path: "/rooms/example", cache: "no-cache"},
		{path: "/assets/app-abcd1234.js", cache: "public, max-age=31536000, immutable"},
	} {
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", "https://chat.example"+tc.path, nil))
		if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != tc.cache {
			t.Fatalf("path=%s status=%d cache=%q", tc.path, w.Code, w.Header().Get("Cache-Control"))
		}
		csp := w.Header().Get("Content-Security-Policy")
		for _, directive := range []string{"default-src 'self'", "script-src 'self' blob: 'wasm-unsafe-eval'", "worker-src 'self' blob:", "connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:*", "frame-ancestors 'none'"} {
			if !strings.Contains(csp, directive) {
				t.Fatalf("path=%s CSP missing %q: %q", tc.path, directive, csp)
			}
		}
		if w.Header().Get("X-Frame-Options") != "DENY" {
			t.Fatalf("path=%s missing frame denial", tc.path)
		}
	}
}

func TestDevelopmentHandlerDoesNotEmitProductionCSP(t *testing.T) {
	a := New(testStore{}, newTestSessions(false), Config{AppURL: "http://localhost:5173"})
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, httptest.NewRequest("GET", "http://localhost:5173/healthz", nil))
	if got := w.Header().Get("Content-Security-Policy"); got != "" {
		t.Fatalf("development CSP=%q", got)
	}
}
func TestWebSocketOriginRequiresExactSchemeAndHost(t *testing.T) {
	a := New(testStore{}, newTestSessions(false), Config{AppURL: "https://chat.example"})
	tests := []struct {
		origin  string
		allowed bool
	}{
		{origin: "https://chat.example", allowed: true},
		{origin: "http://chat.example", allowed: false},
		{origin: "https://evil.example", allowed: false},
	}
	for _, tc := range tests {
		r := httptest.NewRequest("GET", "https://chat.example/api/v1/rooms/x/ws", nil)
		r.Header.Set("Origin", tc.origin)
		if got := a.websocketOriginAllowed(r); got != tc.allowed {
			t.Fatalf("origin %s allowed=%v want %v", tc.origin, got, tc.allowed)
		}
	}
}

func TestLoginCanonicalizesLoopbackHost(t *testing.T) {
	a := New(testStore{}, newTestSessions(false), Config{AppURL: "http://localhost:5173", WorkOSClientID: "client", WorkOSRedirectURI: "http://localhost:5173/api/v1/auth/callback"})
	r := httptest.NewRequest("GET", "http://127.0.0.1:5173/api/v1/auth/login", nil)
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusTemporaryRedirect || w.Header().Get("Location") != "http://localhost:5173/api/v1/auth/login" {
		t.Fatalf("status=%d location=%q", w.Code, w.Header().Get("Location"))
	}
	if len(w.Result().Cookies()) != 0 {
		t.Fatal("state cookie issued on non-canonical host")
	}
}

func TestICECredentialsAreAuthenticatedAndShortLived(t *testing.T) {
	u := User{ID: "user-1", Email: "a@example.test", Name: "A"}
	s := newTestSessions(false)
	a := New(testStore{user: u}, s, Config{ICEURLs: []string{"stun:test"}, TURNURLs: []string{"turn:test"}, TURNSecret: "turn-secret"})
	req := httptest.NewRequest("GET", "http://localhost/api/v1/ice", nil)
	w0 := httptest.NewRecorder()
	if e := s.Set(req, w0, u.ID); e != nil {
		t.Fatal(e)
	}
	req.AddCookie(w0.Result().Cookies()[0])
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var out struct {
		TTL     int              `json:"ttl_seconds"`
		Servers []map[string]any `json:"ice_servers"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	if out.TTL != 600 || len(out.Servers) != 2 || out.Servers[1]["credential"] == "" {
		t.Fatalf("unexpected response: %#v", out)
	}
}

func TestSFUJoinReturns503WhenNotConfigured(t *testing.T) {
	u := User{ID: "11111111-1111-1111-1111-111111111111", Email: "a@example.test", Name: "A"}
	s := newTestSessions(false)
	a := New(testStore{user: u}, s, Config{})
	req := httptest.NewRequest("GET", "http://localhost/api/v1/rooms/22222222-2222-2222-2222-222222222222/sfu-join", nil)
	w0 := httptest.NewRecorder()
	if e := s.Set(req, w0, u.ID); e != nil {
		t.Fatal(e)
	}
	req.AddCookie(w0.Result().Cookies()[0])
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, req)
	if w.Code != 503 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestSFUJoinTokenIsAuthenticatedAndShortLived(t *testing.T) {
	u := User{ID: "11111111-1111-4111-8111-111111111111", Email: "a@example.test", Name: "A"}
	roomID := "22222222-2222-4222-8222-222222222222"
	s := newTestSessions(false)
	a := New(testStore{user: u}, s, Config{SFUURL: "wss://sfu.example.test/ws", SFUJoinSecret: "sfu-join-test-secret-32-bytes-long!!"})
	req := httptest.NewRequest("GET", "http://localhost/api/v1/rooms/"+roomID+"/sfu-join", nil)
	w0 := httptest.NewRecorder()
	if e := s.Set(req, w0, u.ID); e != nil {
		t.Fatal(e)
	}
	req.AddCookie(w0.Result().Cookies()[0])
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var out struct {
		SFUURL string `json:"sfu_url"`
		Token  string `json:"token"`
		TTL    int    `json:"ttl_seconds"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	if out.SFUURL != "wss://sfu.example.test/ws" || out.TTL != 120 {
		t.Fatalf("unexpected response: %#v", out)
	}
	parts := strings.Split(out.Token, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		t.Fatalf("token is not payload.signature: %q", out.Token)
	}
	payload, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		t.Fatal(e)
	}
	var claims struct {
		RoomID string `json:"room_id"`
		UserID string `json:"user_id"`
		PeerID string `json:"peer_id"`
		Exp    int64  `json:"exp"`
	}
	if e := json.Unmarshal(payload, &claims); e != nil {
		t.Fatal(e)
	}
	if claims.RoomID != roomID || claims.UserID != u.ID || claims.PeerID != u.ID {
		t.Fatalf("unexpected claims: %#v", claims)
	}
	if ttl := claims.Exp - time.Now().Unix(); ttl <= 0 || ttl > 120 {
		t.Fatalf("token exp is not short-lived: %d seconds out", ttl)
	}

	mac := hmac.New(sha256.New, []byte("sfu-join-test-secret-32-bytes-long!!"))
	mac.Write([]byte(parts[0]))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if parts[1] != expected {
		t.Fatal("signature does not verify against the configured SFUJoinSecret")
	}

	mac.Reset()
	mac.Write([]byte("sfu-join-test-secret-32-bytes-long!!"))
	badMac := hmac.New(sha256.New, []byte("wrong-secret-at-least-32-bytes-long!!"))
	badMac.Write([]byte(parts[0]))
	if hmac.Equal(mac.Sum(nil), badMac.Sum(nil)) {
		t.Fatal("test setup broken: different secrets produced the same MAC")
	}
}

func TestHubRelayIsScopedToRoom(t *testing.T) {
	h := NewHub()
	target := &client{user: "b", send: make(chan wire, 1)}
	h.add("one", target)
	defer h.remove("one", target)
	if h.relay("two", "b", wire{Type: "offer"}) {
		t.Fatal("relayed across rooms")
	}
	if !h.relay("one", "b", wire{Type: "offer", From: "a"}) {
		t.Fatal("did not relay in room")
	}
	select {
	case got := <-target.send:
		if got.From != "a" {
			t.Fatalf("from=%q", got.From)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out")
	}
}
