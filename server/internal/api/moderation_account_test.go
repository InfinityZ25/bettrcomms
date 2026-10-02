package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func signedSFUTestClaims(t *testing.T, secret string, claims sfuClaims) string {
	t.Helper()
	raw, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

type managedSessionFixture struct{ *memorySessionStore }

func (s *managedSessionFixture) CreateDeviceSession(ctx context.Context, h []byte, user string, expires time.Time, _ string) error {
	return s.CreateSession(ctx, h, user, expires)
}
func (s *managedSessionFixture) ResolveSession(ctx context.Context, h []byte, now time.Time) (DeviceSession, error) {
	user, err := s.SessionUser(ctx, h, now)
	return DeviceSession{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", UserID: user, ExpiresAt: now.Add(time.Hour)}, err
}
func (s *managedSessionFixture) ListDeviceSessions(context.Context, string, string) ([]DeviceSession, error) {
	return nil, ErrForbidden
}
func (s *managedSessionFixture) RevokeDeviceSessions(context.Context, string, string, bool) ([]string, error) {
	return nil, ErrForbidden
}

func issueAccountSession(t *testing.T, a *API, user User) (*http.Cookie, DeviceSession) {
	t.Helper()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0")
	w := httptest.NewRecorder()
	if err := a.Sessions.Set(r, w, user.ID); err != nil {
		t.Fatal(err)
	}
	cookie := w.Result().Cookies()[0]
	r.AddCookie(cookie)
	session, err := a.Sessions.Resolve(r)
	if err != nil {
		t.Fatal(err)
	}
	return cookie, session
}
func accountHTTP(t *testing.T, a *API, cookie *http.Cookie, method, path, body string, status int) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://localhost/api/v1"+path, strings.NewReader(body))
	if cookie != nil {
		r.AddCookie(cookie)
	}
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s returned %d, want %d: %s", method, path, w.Code, status, w.Body.String())
	}
	return w
}
func TestModerationControlsIntegration(t *testing.T) {
	s := conversationTestStore(t)
	ctx := context.Background()
	owner, err := s.UpsertDevUser("mod-owner@example.test", "Owner")
	if err != nil {
		t.Fatal(err)
	}
	member, err := s.UpsertDevUser("mod-member@example.test", "Member")
	if err != nil {
		t.Fatal(err)
	}
	room, err := s.CreateRoom(owner.ID, "Moderation")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room.ID, member.ID)
	if err != nil {
		t.Fatal(err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost"})
	ownCookie, _ := issueAccountSession(t, a, owner)
	memberCookie, _ := issueAccountSession(t, a, member)
	accountHTTP(t, a, memberCookie, "PUT", "/rooms/"+room.ID+"/moderation/slow-mode", `{"seconds":30}`, 403)
	accountHTTP(t, a, ownCookie, "PUT", "/rooms/"+room.ID+"/moderation/slow-mode", `{"seconds":3601}`, 400)
	accountHTTP(t, a, ownCookie, "PUT", "/rooms/"+room.ID+"/moderation/slow-mode", `{"seconds":30}`, 200)
	nonce := "11111111-1111-4111-8111-222222222222"
	first, publish, err := s.SendMessage(room.ID, member.ID, "First", "", nonce, nil)
	if err != nil || !publish {
		t.Fatalf("first send: %v", err)
	}
	retry, publish, err := s.SendMessage(room.ID, member.ID, "First", "", nonce, nil)
	if err != nil || publish || retry.ID != first.ID {
		t.Fatalf("idempotency consumed slow mode: %v", err)
	}
	_, _, err = s.SendMessage(room.ID, member.ID, "Too soon", "", "", nil)
	var posting *PostingError
	if !errors.As(err, &posting) || posting.Code != "slow_mode" {
		t.Fatalf("cooldown bypass: %v", err)
	}
	if _, err = s.WriteMessage(room.ID, member.ID, first.ID, "Edited", ""); err != nil {
		t.Fatalf("slow mode blocked editing: %v", err)
	}
	if _, err = s.ReactMessage(room.ID, member.ID, first.ID, "👍", false); err != nil {
		t.Fatalf("slow mode blocked reactions: %v", err)
	}
	for range 2 {
		if _, err = s.WriteMessage(room.ID, owner.ID, "", "Owner exempt", ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.DB.Exec(ctx, `UPDATE room_members SET last_posted_at=NULL WHERE room_id=$1 AND user_id=$2`, room.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := s.SendMessage(room.ID, member.ID, "Race", "", "", nil)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.As(err, &posting) {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatalf("concurrent cooldown accepted %d sends", success)
	}
	accountHTTP(t, a, ownCookie, "PUT", "/rooms/"+room.ID+"/moderation/timeouts/"+owner.ID, `{"seconds":60,"reason":"owner cannot target self"}`, 403)
	accountHTTP(t, a, ownCookie, "PUT", "/rooms/"+room.ID+"/moderation/timeouts/"+member.ID, `{"seconds":60,"reason":"Repeated spam"}`, 200)
	if _, err = s.WriteMessage(room.ID, member.ID, first.ID, "Forbidden edit", ""); !errors.As(err, &posting) || posting.Code != "posting_restricted" {
		t.Fatalf("timeout edit: %v", err)
	}
	if _, err = s.ReactMessage(room.ID, member.ID, first.ID, "👍", false); !errors.As(err, &posting) {
		t.Fatalf("timeout reaction: %v", err)
	}
	err = s.SavePendingAttachment(room.ID, member.ID, "messages/test", MessageAttachment{ID: "22222222-2222-4222-8222-222222222222", Filename: "test.txt", ContentType: "text/plain", SizeBytes: 1})
	if !errors.As(err, &posting) {
		t.Fatalf("timeout upload: %v", err)
	}
	if _, err = s.DeleteMessage(room.ID, member.ID, first.ID); err != nil {
		t.Fatalf("timeout blocked deletion: %v", err)
	}
	accountHTTP(t, a, ownCookie, "DELETE", "/rooms/"+room.ID+"/moderation/timeouts/"+member.ID, "", 200)
	if err = s.ModerateMember(room.ID, owner.ID, member.ID, "timeout", "expiry", 60); err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec(ctx, `UPDATE room_members SET posting_restricted_until=now()-interval '1 second' WHERE room_id=$1 AND user_id=$2`, room.ID, member.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.CheckPosting(room.ID, member.ID); err != nil {
		t.Fatalf("expired timeout: %v", err)
	}
	accountHTTP(t, a, ownCookie, "PUT", "/rooms/"+room.ID+"/moderation/bans/"+member.ID, `{"reason":"Repeated spam"}`, 200)
	if _, err = s.RoomForMember(room.ID, member.ID); err == nil {
		t.Fatal("banned member retained access")
	}
	friend, err := s.CreateFriendRequest(owner.ID, member.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.AcceptFriendRequest(friend.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	inviteToken := "moderation-banned-member-fixture"
	invite, err := s.CreateInvite(room.ID, owner.ID, inviteToken, nil, 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.PreviewInvite(inviteToken, member.ID); !errors.Is(err, ErrInviteUnavailable) {
		t.Fatal("banned member could preview an invitation")
	}
	if _, _, err = s.RedeemInvite(inviteToken, member.ID); !errors.Is(err, ErrForbidden) {
		t.Fatal("invitation restored banned membership")
	}
	var uses int
	if err = s.DB.QueryRow(ctx, `SELECT uses FROM room_invites WHERE id=$1`, invite.ID).Scan(&uses); err != nil || uses != 0 {
		t.Fatal("rejected invitation consumed a use")
	}
	if err = s.AddRoomMember(room.ID, owner.ID, member.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("banned member rejoined: %v", err)
	}
	accountHTTP(t, a, memberCookie, "GET", "/rooms/"+room.ID+"/messages", "", 403)
	accountHTTP(t, a, ownCookie, "DELETE", "/rooms/"+room.ID+"/moderation/bans/"+member.ID, "", 200)
	if err = s.AddRoomMember(room.ID, owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	bans, audit, _, err := s.RoomModeration(room.ID, owner.ID, "")
	if err != nil || len(bans) != 0 || len(audit) < 5 {
		t.Fatalf("audit incomplete: %v %d", err, len(audit))
	}
}

func TestAccountSessionsRevocationIntegration(t *testing.T) {
	s := conversationTestStore(t)
	user, err := s.UpsertDevUser("sessions@example.test", "Sessions")
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.UpsertDevUser("other@example.test", "Other")
	if err != nil {
		t.Fatal(err)
	}
	room, err := s.CreateRoom(user.ID, "Sessions")
	if err != nil {
		t.Fatal(err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost", SFUJoinSecret: "test-signing-key-at-least-32-characters"})
	cookie1, session1 := issueAccountSession(t, a, user)
	cookie2, session2 := issueAccountSession(t, a, user)
	cookieOther, sessionOther := issueAccountSession(t, a, other)
	listed := accountHTTP(t, a, cookie1, "GET", "/me/sessions", "", 200)
	var response struct {
		Sessions []DeviceSession `json:"sessions"`
	}
	if err = json.Unmarshal(listed.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Sessions) != 2 {
		t.Fatal("sessions did not remain account scoped")
	}
	for _, item := range response.Sessions {
		if item.Current != (item.ID == session1.ID) {
			t.Fatal("current session identity wrong")
		}
	}
	accountHTTP(t, a, cookieOther, "DELETE", "/me/sessions/"+session1.ID, "", 404)
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	a.Config.AppURL = srv.URL
	a.AllowedOrigins = []string{strings.TrimPrefix(srv.URL, "http://")}
	dial := func(path string, cookie *http.Cookie) *websocket.Conn {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		headers := http.Header{}
		headers.Set("Cookie", cookie.String())
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1"+path, &websocket.DialOptions{HTTPHeader: headers})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.CloseNow() })
		var ready wire
		if err = wsjsonRead(ctx, conn, &ready); err != nil {
			t.Fatal(err)
		}
		return conn
	}
	events1 := dial("/events", cookie1)
	events2 := dial("/events", cookie2)
	signal2 := dial("/rooms/"+room.ID+"/ws?peer_id=33333333-3333-4333-8333-333333333333&join_mode=additional", cookie2)
	voiceHeaders := http.Header{}
	voiceHeaders.Set("Cookie", cookie2.String())
	voice, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/rooms/"+room.ID+"/voice-relay?peer_id=33333333-3333-4333-8333-333333333333", &websocket.DialOptions{HTTPHeader: voiceHeaders})
	if err != nil {
		t.Fatal(err)
	}
	defer voice.CloseNow()
	claims := sfuClaims{RoomID: room.ID, UserID: user.ID, PeerID: "33333333-3333-4333-8333-333333333333", SessionID: session2.ID, Exp: time.Now().Add(time.Minute).Unix()}
	headers := http.Header{}
	claims.SessionID = session1.ID
	headers.Set("Authorization", "Bearer "+signedSFUTestClaims(t, a.Config.SFUJoinSecret, claims))
	denied, deniedResponse, deniedErr := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/sfu/authorization", &websocket.DialOptions{HTTPHeader: headers})
	if deniedErr == nil {
		denied.CloseNow()
		t.Fatal("another session authorized the existing peer")
	}
	if deniedResponse == nil || deniedResponse.StatusCode != 403 {
		t.Fatal("peer session mismatch was not rejected before upgrade")
	}
	claims.SessionID = session2.ID
	headers.Set("Authorization", "Bearer "+signedSFUTestClaims(t, a.Config.SFUJoinSecret, claims))
	lease, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/sfu/authorization", &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.CloseNow()
	var ready map[string]bool
	if err = wsjsonRead(context.Background(), lease, &ready); err != nil || !ready["authorized"] {
		t.Fatal("SFU lease missing")
	}
	duplicate, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/sfu/authorization", &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		t.Fatal("duplicate authorization handshake did not reach bounded rejection")
	}
	duplicateCtx, duplicateCancel := context.WithTimeout(context.Background(), 3*time.Second)
	_, _, err = duplicate.Read(duplicateCtx)
	duplicateCancel()
	duplicate.CloseNow()
	if websocket.CloseStatus(err) != websocket.StatusTryAgainLater {
		t.Fatal("duplicate authorization replaced the active peer lease")
	}
	leaseCtx, leaseCancel := context.WithTimeout(context.Background(), 3*time.Second)
	if err = lease.Write(leaseCtx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	_, pong, err := lease.Read(leaseCtx)
	leaseCancel()
	if err != nil || string(pong) != "pong" {
		t.Fatal("duplicate lease interrupted the original authorization")
	}
	accountHTTP(t, a, cookie1, "POST", "/me/sessions/revoke-others", "{}", 200)
	for _, conn := range []*websocket.Conn{events2, signal2, voice, lease} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		for {
			_, _, err = conn.Read(ctx)
			if err != nil {
				break
			}
		}
		cancel()
		if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
			t.Fatalf("revoked socket remained open: %v", err)
		}
	}
	accountHTTP(t, a, cookie2, "GET", "/me", "", 401)
	accountHTTP(t, a, cookie1, "GET", "/me", "", 200)
	accountHTTP(t, a, cookieOther, "GET", "/me/sessions", "", 200)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err = wsjsonWrite(ctx, events1, wire{Type: "ping", RequestID: "still-current"}); err != nil {
		t.Fatal(err)
	}
	for {
		var message wire
		if err = wsjsonRead(ctx, events1, &message); err != nil {
			t.Fatal(err)
		}
		if message.Type == "pong" && message.RequestID == "still-current" {
			break
		}
	}
	rejected, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/sfu/authorization", &websocket.DialOptions{HTTPHeader: headers})
	if err == nil {
		rejected.CloseNow()
		t.Fatal("SFU token resurrected a revoked session")
	}
	if sessionOther.ID == session1.ID {
		t.Fatal("session IDs reused")
	}
	accountHTTP(t, a, cookie1, "DELETE", "/me/sessions/"+session1.ID, "", 200)
	accountHTTP(t, a, cookie1, "GET", "/me", "", 401)
}

func TestAccountDeletionIntegration(t *testing.T) {
	s := conversationTestStore(t)
	ctx := context.Background()
	owner, err := s.UpsertDevUser("delete@example.test", "Delete Me")
	if err != nil {
		t.Fatal(err)
	}
	peer, err := s.UpsertDevUser("remaining@example.test", "Remaining")
	if err != nil {
		t.Fatal(err)
	}
	username, bio := "delete_me", "Personal biography"
	if _, err = s.UpdateProfile(owner.ID, ProfileUpdate{Username: &username, Bio: &bio}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetAvatar(owner.ID, []byte("avatar fixture")); err != nil {
		t.Fatal(err)
	}
	friend, err := s.CreateFriendRequest(owner.ID, peer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.AcceptFriendRequest(friend.ID, peer.ID); err != nil {
		t.Fatal(err)
	}
	group, err := s.CreateGroup(owner.ID, "Keep group", []string{peer.ID})
	if err != nil {
		t.Fatal(err)
	}
	room, err := s.CreateRoom(owner.ID, "Keep channel")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room.ID, peer.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateInvite(room.ID, owner.ID, "deletion-invitation-fixture", nil, 10); err != nil {
		t.Fatal(err)
	}
	message, err := s.WriteMessage(room.ID, owner.ID, "", "Personal text", "")
	if err != nil {
		t.Fatal(err)
	}
	attachment := MessageAttachment{ID: "44444444-4444-4444-8444-444444444444", Filename: "personal.txt", ContentType: "text/plain", SizeBytes: 1}
	if err = s.SavePendingAttachment(room.ID, owner.ID, "messages/deletion", attachment); err != nil {
		t.Fatal(err)
	}
	if err = s.CompletePendingAttachment(attachment.ID, room.ID); err != nil {
		t.Fatal(err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost"})
	cookie, _ := issueAccountSession(t, a, owner)
	accountHTTP(t, a, cookie, "DELETE", "/me/account", `{"confirmation":"DELETE","email":"wrong@example.test"}`, 400)
	accountHTTP(t, a, cookie, "DELETE", "/me/account", `{"confirmation":"DELETE","email":"delete@example.test"}`, 409)
	accountHTTP(t, a, cookie, "POST", "/rooms/"+room.ID+"/ownership", `{"user_id":"`+peer.ID+`"}`, 200)
	accountHTTP(t, a, cookie, "DELETE", "/me/account", `{"confirmation":"DELETE","email":"delete@example.test"}`, 200)
	accountHTTP(t, a, cookie, "GET", "/me", "", 401)
	if _, err = s.UserByID(owner.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted account still available: %v", err)
	}
	history, err := s.MessagePage(room.ID, peer.ID, "", 20)
	if err != nil || len(history.Messages) != 1 {
		t.Fatalf("remaining history unavailable: %v", err)
	}
	deleted := history.Messages[0]
	if deleted.ID != message.ID || deleted.DeletedAt == nil || deleted.Body != "" || deleted.Author.Name != "Deleted account" || deleted.Author.AvatarURL != nil || deleted.Author.Username != nil || deleted.Author.Bio != "" {
		t.Fatal("personal content or identity retained")
	}
	if _, _, err = s.AttachmentForMember(room.ID, peer.ID, attachment.ID); err == nil {
		t.Fatal("deleted attachment remained downloadable")
	}
	var key string
	if err = s.DB.QueryRow(ctx, `SELECT object_key FROM message_attachments WHERE id=$1 AND deleted_at IS NOT NULL`, attachment.ID).Scan(&key); err != nil || key != "messages/deletion" {
		t.Fatal("cleanup lost S3 object key")
	}
	if _, err = s.CreateRoom(owner.ID, "After deletion"); err == nil {
		t.Fatal("deleted account created new room")
	}
	var privateRows int
	if err = s.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM user_avatars WHERE user_id=$1)+(SELECT count(*) FROM room_invites WHERE creator_id=$1)`, owner.ID).Scan(&privateRows); err != nil || privateRows != 0 {
		t.Fatal("deleted account retained avatar bytes or invitations")
	}
	remainingGroup, err := s.RoomForMember(group.ID, peer.ID)
	if err != nil || remainingGroup.OwnerID != peer.ID || remainingGroup.Role != "owner" {
		t.Fatal("account deletion did not transfer group ownership")
	}
	if err = s.CreateSession(ctx, []byte("revive-deleted-session"), owner.ID, time.Now().Add(time.Hour)); !errors.Is(err, ErrForbidden) {
		t.Fatal("legacy session creation resurrected a deleted account")
	}
	if _, err = s.SetAvatar(owner.ID, []byte("resurrect-avatar")); !errors.Is(err, ErrNotFound) {
		t.Fatal("deleted account wrote avatar bytes")
	}
	replacement, err := s.UpsertDevUser("delete@example.test", "New account")
	if err != nil || replacement.ID == owner.ID {
		t.Fatal("deleted identity resurrected old account")
	}
}

func TestDeviceDescriptionsAreBounded(t *testing.T) {
	if got := deviceName(strings.Repeat("sensitive raw UA ", 1000)); got != "Other system · Browser" {
		t.Fatalf("raw user agent leaked into device description")
	}
	if got := deviceName("Mozilla Windows Chrome/123 Edg/123"); got != "Windows · Edge" {
		t.Fatal(got)
	}
}

type gatedAccountStorage struct {
	started chan string
	release chan struct{}
}

func (s *gatedAccountStorage) Put(ctx context.Context, key string, body io.Reader, _ int64, _ string) error {
	if _, err := io.Copy(io.Discard, body); err != nil {
		return err
	}
	s.started <- key
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (*gatedAccountStorage) URL(context.Context, string, string, string, bool) (string, error) {
	return "https://example.test/file", nil
}
func (*gatedAccountStorage) Delete(context.Context, string) error { return nil }

func TestRevokedSessionCannotFinalizeInFlightUploadIntegration(t *testing.T) {
	s := conversationTestStore(t)
	user, err := s.UpsertDevUser("upload-revoke@example.test", "Uploader")
	if err != nil {
		t.Fatal(err)
	}
	room, err := s.CreateRoom(user.ID, "Upload")
	if err != nil {
		t.Fatal(err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost"})
	currentCookie, _ := issueAccountSession(t, a, user)
	uploadCookie, _ := issueAccountSession(t, a, user)
	storage := &gatedAccountStorage{started: make(chan string, 1), release: make(chan struct{})}
	a.Attachments = storage
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(storage.release) }) }
	t.Cleanup(release)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", "note.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write([]byte("upload is in flight")); err != nil {
		t.Fatal(err)
	}
	if err = form.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "http://localhost/api/v1/rooms/"+room.ID+"/attachments", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	request.AddCookie(uploadCookie)
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { a.Handler().ServeHTTP(response, request); close(done) }()
	var key string
	select {
	case key = <-storage.started:
	case <-time.After(3 * time.Second):
		t.Fatal("upload did not reach object storage")
	}
	accountHTTP(t, a, currentCookie, "POST", "/me/sessions/revoke-others", "{}", 200)
	release()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("revoked upload did not finish")
	}
	if response.Code != 401 {
		t.Fatalf("revoked upload returned %d", response.Code)
	}
	var id, state string
	var deleted *time.Time
	if err = s.DB.QueryRow(context.Background(), `SELECT id::text,upload_state,deleted_at FROM message_attachments WHERE object_key=$1`, key).Scan(&id, &state, &deleted); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || deleted == nil {
		t.Fatal("revoked stored object was not retained for immediate cleanup")
	}
	if _, _, err = s.AttachmentForMember(room.ID, user.ID, id); !errors.Is(err, ErrNotFound) {
		t.Fatal("another active session can download a revoked upload")
	}
	accountHTTP(t, a, currentCookie, "GET", "/me", "", 200)
}

func TestHubRevocationStopsDeliveryAndAdmission(t *testing.T) {
	hub := NewHub()
	one := &client{user: "one", peer: "one-peer", send: make(chan wire, 8)}
	two := &client{user: "two", peer: "two-peer", send: make(chan wire, 8)}
	hub.add("room", one)
	hub.add("room", two)
	for len(one.send) > 0 {
		<-one.send
	}
	hub.disconnectRoomUser("room", "one")
	if !one.revoked.Load() || hub.activeSignal("room", "one", "one-peer") != nil {
		t.Fatal("revoked signaling peer retained admission")
	}
	hub.broadcast("room", nil, wire{Type: "chat.message"})
	if one.deliver(wire{Type: "chat.message"}) || len(one.send) != 0 {
		t.Fatal("revoked peer received new events")
	}
	if presence := hub.callPresence("room"); len(presence) != 1 || presence[0].UserID != "two" {
		t.Fatal("revoked peer remained in call roster")
	}
}

func TestModerationBanPagesIntegration(t *testing.T) {
	s := conversationTestStore(t)
	owner, err := s.UpsertDevUser("ban-pages@example.test", "Owner")
	if err != nil {
		t.Fatal(err)
	}
	room, err := s.CreateRoom(owner.ID, "Ban pages")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec(context.Background(), `WITH people AS(INSERT INTO users(email,name) SELECT 'ban-page-'||n||'@example.test','Banned '||n FROM generate_series(1,51) n RETURNING id) INSERT INTO room_bans(room_id,user_id,actor_id,reason) SELECT $1,id,$2,'Repeated spam' FROM people`, room.ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	first, _, next, err := s.RoomModeration(room.ID, owner.ID, "")
	if err != nil || len(first) != 50 || next == "" {
		t.Fatalf("first ban page was not bounded: count=%d err=%v", len(first), err)
	}
	second, _, end, err := s.RoomModeration(room.ID, owner.ID, next)
	if err != nil || len(second) != 1 || end != "" {
		t.Fatalf("last ban page omitted members: count=%d err=%v", len(second), err)
	}
	for _, item := range first {
		if item.User.ID == second[0].User.ID {
			t.Fatal("ban cursor repeated a user")
		}
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost"})
	cookie, _ := issueAccountSession(t, a, owner)
	accountHTTP(t, a, cookie, "GET", "/rooms/"+room.ID+"/moderation?bans_after=invalid", "", 400)
	accountHTTP(t, a, cookie, "DELETE", "/rooms/"+room.ID+"/moderation/bans/"+second[0].User.ID, "", 200)
}

func TestExpiredAuthenticationDoesNotOverwriteNewCookie(t *testing.T) {
	a := New(testStore{}, newTestSessions(false), Config{})
	request := httptest.NewRequest("GET", "http://localhost/api/v1/me", nil)
	request.AddCookie(&http.Cookie{Name: "bettercomms_session", Value: "expired-session"})
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)
	if response.Code != 401 || len(response.Result().Cookies()) != 0 {
		t.Fatal("an old unauthorized response can overwrite a newer sign-in cookie")
	}
}
