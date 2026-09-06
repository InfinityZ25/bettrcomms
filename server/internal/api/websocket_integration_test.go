package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWebSocketSignalIntegration(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, e := pgxpool.New(ctx, dbURL)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	for _, path := range []string{"../../migrations/001_init.sql", "../../migrations/002_direct_rooms.sql"} {
		migration, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = pool.Exec(ctx, string(migration)); e != nil {
			t.Fatal(e)
		}
	}
	store := &PostgresStore{DB: pool}
	suffix := time.Now().Format("150405.000000000")
	u1, e := store.UpsertDevUser("ws-a-"+suffix+"@example.test", "WS A")
	if e != nil {
		t.Fatal(e)
	}
	u2, e := store.UpsertDevUser("ws-b-"+suffix+"@example.test", "WS B")
	if e != nil {
		t.Fatal(e)
	}
	room, e := store.CreateRoom(u1.ID, "Signal test")
	if e != nil {
		t.Fatal(e)
	}
	defer func() {
		pool.Exec(ctx, `DELETE FROM rooms WHERE id=$1`, room.ID)
		pool.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2`, u1.ID, u2.ID)
	}()
	if _, e = pool.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room.ID, u2.ID); e != nil {
		t.Fatal(e)
	}
	sessions := Sessions{Store: store}
	a := New(store, sessions, Config{})
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	a.Config.AppURL = srv.URL
	dial := func(u User) (*websocket.Conn, *http.Cookie) {
		w := httptest.NewRecorder()
		if e := sessions.Set(httptest.NewRequest("GET", "/", nil), w, u.ID); e != nil {
			t.Fatal(e)
		}
		h := http.Header{}
		h.Set("Cookie", w.Result().Cookies()[0].String())
		h.Set("Origin", srv.URL)
		c, _, e := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/rooms/"+room.ID+"/ws", &websocket.DialOptions{HTTPHeader: h})
		if e != nil {
			t.Fatal(e)
		}
		return c, w.Result().Cookies()[0]
	}
	c1, cookie1 := dial(u1)
	defer c1.CloseNow()
	readWire := func(c *websocket.Conn) wire {
		var v wire
		if e := wsjsonRead(ctx, c, &v); e != nil {
			t.Fatal(e)
		}
		return v
	}
	if got := readWire(c1); got.Type != "peers" {
		t.Fatalf("first frame=%#v", got)
	}
	c2, cookie2 := dial(u2)
	defer c2.CloseNow()
	if got := readWire(c2); got.Type != "peers" {
		t.Fatalf("second first frame=%#v", got)
	}
	if got := readWire(c1); got.Type != "peer.joined" || got.From != u2.ID {
		t.Fatalf("join=%#v", got)
	}
	if e := wsjsonWrite(ctx, c1, wire{Type: "ping", RequestID: strings.Repeat("x", 129)}); e != nil {
		t.Fatal(e)
	}
	if got := readWire(c1); got.Type != "error" || got.Error == nil || got.Error.Code != "invalid_ping" {
		t.Fatalf("invalid ping response=%#v", got)
	}
	if e := wsjsonWrite(ctx, c1, wire{Type: "ping", RequestID: "opaque-nonce"}); e != nil {
		t.Fatal(e)
	}
	if got := readWire(c1); got.Type != "pong" || got.RequestID != "opaque-nonce" {
		t.Fatalf("pong=%#v", got)
	}
	description := json.RawMessage(`{"type":"offer","sdp":"exact-sdp"}`)
	if e := wsjsonWrite(ctx, c1, wire{Type: "offer", To: u2.ID, Description: description}); e != nil {
		t.Fatal(e)
	}
	got := readWire(c2)
	if got.Type != "offer" || got.From != u1.ID || got.To != u2.ID || string(got.Description) != string(description) {
		t.Fatalf("relay=%#v description=%s", got, string(got.Description))
	}
	tracks := json.RawMessage(`[{"source":"screen","trackId":"video-1","streamId":"stream-1","mediaKind":"video","enabled":true}]`)
	if e := wsjsonWrite(ctx, c1, wire{Type: "offer", To: u2.ID, Transport: "native-screen", CaptureID: "capture-test", Description: description}); e != nil {
		t.Fatal(e)
	}
	nativeOffer := readWire(c2)
	if nativeOffer.Transport != "native-screen" || nativeOffer.CaptureID != "capture-test" || nativeOffer.From != u1.ID || string(nativeOffer.Description) != string(description) {
		t.Fatalf("native relay lost routing metadata: %#v", nativeOffer)
	}
	stop := json.RawMessage(`{"kind":"native-screen-stop","captureId":"capture-test"}`)
	if e := wsjsonWrite(ctx, c1, wire{Type: "signal", To: u2.ID, Transport: "native-screen", CaptureID: "capture-test", Data: stop}); e != nil {
		t.Fatal(e)
	}
	if got := readWire(c2); got.Transport != "native-screen" || string(got.Data) != string(stop) || got.From != u1.ID {
		t.Fatalf("native stop relay=%#v", got)
	}
	if e := wsjsonWrite(ctx, c2, wire{Type: "track-metadata", To: u1.ID, Tracks: tracks}); e != nil {
		t.Fatal(e)
	}
	metadata := readWire(c1)
	if metadata.From != u2.ID || string(metadata.Tracks) != string(tracks) {
		t.Fatalf("metadata=%#v tracks=%s", metadata, string(metadata.Tracks))
	}
	dialVoice := func(cookie *http.Cookie) *websocket.Conn {
		h := http.Header{}
		h.Set("Cookie", cookie.String())
		h.Set("Origin", srv.URL)
		c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/rooms/"+room.ID+"/voice-relay", &websocket.DialOptions{HTTPHeader: h})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	v1, v2 := dialVoice(cookie1), dialVoice(cookie2)
	defer v1.CloseNow()
	defer v2.CloseNow()
	ciphertext := base64.StdEncoding.EncodeToString(make([]byte, 32))
	if err := wsjsonWrite(ctx, v1, voiceWire{Type: "voice", To: u2.ID, From: "spoofed", Epoch: "epoch-1", Sequence: 7, Data: ciphertext}); err != nil {
		t.Fatal(err)
	}
	var voice voiceWire
	if err := wsjsonRead(ctx, v2, &voice); err != nil {
		t.Fatal(err)
	}
	if voice.From != u1.ID || voice.To != u2.ID || voice.Sequence != 7 || voice.Data != ciphertext {
		t.Fatalf("voice routing metadata invalid: type=%q from=%q to=%q sequence=%d", voice.Type, voice.From, voice.To, voice.Sequence)
	}
	c3, cookie3 := dial(u2)
	defer c3.CloseNow()
	if got := readWire(c3); got.Type != "peers" {
		t.Fatalf("replacement first frame=%#v", got)
	}
	closeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if _, _, e := c2.Read(closeCtx); websocket.CloseStatus(e) != websocket.StatusPolicyViolation {
		t.Fatalf("replaced socket close=%v status=%v", e, websocket.CloseStatus(e))
	}
	voiceCloseCtx, voiceCloseCancel := context.WithTimeout(ctx, 2*time.Second)
	defer voiceCloseCancel()
	if _, _, e := v2.Read(voiceCloseCtx); websocket.CloseStatus(e) != websocket.StatusPolicyViolation {
		t.Fatalf("replaced voice socket close=%v status=%v", e, websocket.CloseStatus(e))
	}
	v3 := dialVoice(cookie3)
	defer v3.CloseNow()
	logoutReq, e := http.NewRequest("POST", srv.URL+"/api/v1/auth/logout", strings.NewReader(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	logoutReq.Header.Set("Origin", srv.URL)
	logoutReq.Header.Set("Content-Type", "application/json")
	logoutReq.AddCookie(cookie3)
	res, e := http.DefaultClient.Do(logoutReq)
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("logout status=%d", res.StatusCode)
	}
	logoutCtx, logoutCancel := context.WithTimeout(ctx, 2*time.Second)
	defer logoutCancel()
	if _, _, e = c3.Read(logoutCtx); websocket.CloseStatus(e) != websocket.StatusPolicyViolation {
		t.Fatalf("logout socket close=%v status=%v", e, websocket.CloseStatus(e))
	}
	logoutVoiceCtx, logoutVoiceCancel := context.WithTimeout(ctx, 2*time.Second)
	defer logoutVoiceCancel()
	if _, _, e = v3.Read(logoutVoiceCtx); websocket.CloseStatus(e) != websocket.StatusPolicyViolation {
		t.Fatalf("logout voice socket close=%v status=%v", e, websocket.CloseStatus(e))
	}
}

func TestRoomManagementAuthorization(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, e := pgxpool.New(ctx, dbURL)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	for _, path := range []string{"../../migrations/001_init.sql", "../../migrations/002_direct_rooms.sql"} {
		sql, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = pool.Exec(ctx, string(sql)); e != nil {
			t.Fatal(e)
		}
	}
	s := &PostgresStore{DB: pool}
	suffix := time.Now().Format("150405.000000000")
	owner, e := s.UpsertDevUser("owner-"+suffix+"@example.test", "Owner")
	if e != nil {
		t.Fatal(e)
	}
	friend, e := s.UpsertDevUser("friend-"+suffix+"@example.test", "Friend")
	if e != nil {
		t.Fatal(e)
	}
	outsider, e := s.UpsertDevUser("outsider-"+suffix+"@example.test", "Outsider")
	if e != nil {
		t.Fatal(e)
	}
	defer func() {
		pool.Exec(ctx, `DELETE FROM rooms WHERE owner_id IN ($1,$2,$3)`, owner.ID, friend.ID, outsider.ID)
		pool.Exec(ctx, `DELETE FROM users WHERE id IN ($1,$2,$3)`, owner.ID, friend.ID, outsider.ID)
	}()
	if _, e = pool.Exec(ctx, `INSERT INTO friend_requests(sender_id,receiver_id,status) VALUES($1,$2,'accepted')`, owner.ID, friend.ID); e != nil {
		t.Fatal(e)
	}
	room, e := s.CreateRoom(owner.ID, "Original")
	if e != nil {
		t.Fatal(e)
	}
	if e = s.AddRoomMember(room.ID, owner.ID, friend.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.RenameRoom(room.ID, friend.ID, "Hijacked"); !errors.Is(e, ErrForbidden) {
		t.Fatalf("non-owner rename=%v", e)
	}
	renamed, e := s.RenameRoom(room.ID, owner.ID, "Renamed")
	if e != nil || renamed.Name != "Renamed" {
		t.Fatalf("rename=%#v %v", renamed, e)
	}
	if e = s.RemoveRoomMember(room.ID, owner.ID, owner.ID); !errors.Is(e, ErrForbidden) {
		t.Fatalf("owner removal=%v", e)
	}
	if e = s.RemoveRoomMember(room.ID, outsider.ID, friend.ID); !errors.Is(e, ErrForbidden) {
		t.Fatalf("outsider removal=%v", e)
	}
	dm1, e := s.CreateDirectRoom(owner.ID, friend.ID)
	if e != nil {
		t.Fatal(e)
	}
	dm2, e := s.CreateDirectRoom(friend.ID, owner.ID)
	if e != nil {
		t.Fatal(e)
	}
	if dm1.ID != dm2.ID || dm1.Kind != "direct" {
		t.Fatalf("direct rooms not idempotent: %#v %#v", dm1, dm2)
	}
}
