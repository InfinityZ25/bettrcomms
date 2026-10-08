package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAvatarNormalization(t *testing.T) {
	original := image.NewNRGBA(image.Rect(0, 0, 500, 300))
	for y := 0; y < 300; y++ {
		for x := 0; x < 500; x++ {
			original.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, original); err != nil {
		t.Fatal(err)
	}
	normalized, err := normalizeAvatar(encoded.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(normalized))
	if err != nil || format != "png" || cfg.Width != 256 || cfg.Height != 256 {
		t.Fatalf("normalized dimensions: %v %s %v", cfg, format, err)
	}
	huge := append([]byte(nil), encoded.Bytes()...)
	binary.BigEndian.PutUint32(huge[16:20], 100_000)
	binary.BigEndian.PutUint32(huge[20:24], 100_000)
	binary.BigEndian.PutUint32(huge[29:33], crc32.ChecksumIEEE(huge[12:29]))
	for _, data := range [][]byte{nil, []byte("<svg></svg>"), encoded.Bytes()[:20], make([]byte, avatarInputLimit+1), huge} {
		if _, err := normalizeAvatar(data); err == nil {
			t.Fatal("accepted invalid/unbounded avatar")
		}
	}
}

func TestPresenceAggregatesDevicesAndHidesInvisible(t *testing.T) {
	h := NewRealtimeHub()
	alice := &realtimeClient{user: "alice", send: make(chan wire, 128)}
	bob := &realtimeClient{user: "bob", send: make(chan wire, 128)}
	second := &realtimeClient{user: "bob", send: make(chan wire, 128)}
	h.add(alice, nil, []User{{ID: "bob"}})
	h.add(bob, nil, []User{{ID: "alice"}})
	h.add(second, nil, []User{{ID: "alice"}})
	h.setPresence("bob", "invisible")
	var contact map[string]any
	json.Unmarshal((<-alice.send).Payload, &contact)
	if contact["online"] != false || contact["status"] != "offline" || contact["desired_status"] != nil {
		t.Fatalf("invisible leaked: %v", contact)
	}
	var own map[string]any
	json.Unmarshal((<-second.send).Payload, &own)
	if own["desired_status"] != "invisible" {
		t.Fatalf("own preference unsynchronized: %v", own)
	}
	if len(h.onlineContacts(alice)) != 0 {
		t.Fatal("invisible leaked through ready online IDs")
	}
	h.setPresence("bob", "dnd")
	<-alice.send
	if h.remove(bob) {
		t.Fatal("closing one device marked remaining device offline")
	}
	snapshot := h.contactSnapshot(alice)
	if len(snapshot) != 1 || snapshot[0]["status"] != "dnd" {
		t.Fatalf("remaining device: %v", snapshot)
	}
	if !h.remove(second) {
		t.Fatal("last device did not become offline")
	}
	h.publishOnline("bob", false)
	json.Unmarshal((<-alice.send).Payload, &contact)
	if contact["status"] != "offline" {
		t.Fatalf("last disconnect: %v", contact)
	}
}

func socialDatabase(t *testing.T) *PostgresStore {
	t.Helper()
	return conversationTestStore(t)
}
func socialUsers(t *testing.T, s *PostgresStore, count int) []User {
	t.Helper()
	suffix := fmt.Sprint(time.Now().UnixNano())
	out := []User{}
	for i := 0; i < count; i++ {
		u, err := s.UpsertDevUser(fmt.Sprintf("social-%s-%d@example.test", suffix, i), fmt.Sprintf("Person %d", i))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, u)
	}
	t.Cleanup(func() {
		ids := []string{}
		for _, u := range out {
			ids = append(ids, u.ID)
		}
		s.DB.Exec(context.Background(), `DELETE FROM rooms WHERE owner_id=ANY($1::uuid[])`, ids)
		s.DB.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1::uuid[])`, ids)
	})
	return out
}
func socialFriend(t *testing.T, s *PostgresStore, left, right string) {
	t.Helper()
	request, err := s.CreateFriendRequest(left, right)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.AcceptFriendRequest(request.ID, right); err != nil {
		t.Fatal(err)
	}
}
func socialRequest(t *testing.T, a *API, u User, method, path, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	session := httptest.NewRecorder()
	seed := httptest.NewRequest("GET", "http://localhost:5173/", nil)
	if err := a.Sessions.Set(seed, session, u.ID); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, "http://localhost:5173/api/v1/"+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Origin", "http://localhost:5173")
	for _, cookie := range session.Result().Cookies() {
		req.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, req)
	return response
}

func TestSocialProfilesIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 3)
	alice, bob, outsider := users[0], users[1], users[2]
	socialFriend(t, s, alice.ID, bob.ID)
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173", DevAuth: true})
	username := "person_" + fmt.Sprint(time.Now().UnixNano())
	name, bio := "New name", "A description"
	payload, _ := json.Marshal(map[string]string{"name": name, "username": strings.ToUpper(username), "bio": bio})
	response := socialRequest(t, a, alice, "PATCH", "me", "application/json", payload)
	if response.Code != 200 {
		t.Fatalf("profile update: %d %s", response.Code, response.Body)
	}
	var data struct{ User User }
	json.Unmarshal(response.Body.Bytes(), &data)
	if data.User.Username == nil || *data.User.Username != username || data.User.Bio != bio || data.User.ProfileVersion != 1 {
		t.Fatalf("profile fields: %+v", data.User)
	}
	existing, err := s.UpsertDevUser(alice.Email, "Provider name")
	if err != nil || existing.Name != name {
		t.Fatalf("edited profile overwritten on login: %+v %v", existing, err)
	}
	response = socialRequest(t, a, bob, "PATCH", "me", "application/json", []byte(fmt.Sprintf(`{"username":%q}`, username)))
	if response.Code != 409 {
		t.Fatalf("duplicate username: %d %s", response.Code, response.Body)
	}
	for _, body := range []string{`{"username":"a"}`, `{"username":"bad!name"}`, `{"bio":"` + strings.Repeat("x", 161) + `"}`, `{"name":" "}`, `{"avatar_url":"https://evil.test/image"}`} {
		response = socialRequest(t, a, alice, "PATCH", "me", "application/json", []byte(body))
		if response.Code != 400 {
			t.Fatalf("invalid update accepted: %s -> %d", body, response.Code)
		}
	}
	imageData := image.NewNRGBA(image.Rect(0, 0, 48, 48))
	imageData.Set(24, 24, color.NRGBA{R: 255, A: 255})
	var encoded bytes.Buffer
	png.Encode(&encoded, imageData)
	var form bytes.Buffer
	writer := multipart.NewWriter(&form)
	file, _ := writer.CreateFormFile("file", "avatar.png")
	file.Write(encoded.Bytes())
	writer.Close()
	response = socialRequest(t, a, alice, "POST", "me/avatar", writer.FormDataContentType(), form.Bytes())
	if response.Code != 200 {
		t.Fatalf("avatar upload: %d %s", response.Code, response.Body)
	}
	json.Unmarshal(response.Body.Bytes(), &data)
	if data.User.ProfileVersion != 2 {
		t.Fatalf("avatar did not advance profile version: %d", data.User.ProfileVersion)
	}
	if data.User.AvatarURL == nil || !strings.HasPrefix(*data.User.AvatarURL, "/api/v1/users/"+alice.ID+"/avatar?version=") {
		t.Fatalf("avatar URL: %+v", data.User)
	}
	response = socialRequest(t, a, bob, "GET", "users/"+alice.ID+"/avatar", "", nil)
	if response.Code != 200 || response.Header().Get("Content-Type") != "image/png" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("authorized avatar: %d", response.Code)
	}
	response = socialRequest(t, a, outsider, "GET", "users/"+alice.ID+"/avatar", "", nil)
	if response.Code != 404 {
		t.Fatalf("outsider avatar: %d", response.Code)
	}
	response = socialRequest(t, a, alice, "DELETE", "me/avatar", "", nil)
	if response.Code != 200 {
		t.Fatal(response.Body)
	}
	json.Unmarshal(response.Body.Bytes(), &data)
	if data.User.ProfileVersion != 3 {
		t.Fatalf("removal did not advance profile version: %d", data.User.ProfileVersion)
	}
	response = socialRequest(t, a, bob, "GET", "users/"+alice.ID+"/avatar", "", nil)
	if response.Code != 404 {
		t.Fatal("deleted avatar remained")
	}
	// WorkOS refreshes preserve both a custom name and explicit avatar removal.
	workos, err := s.UpsertUser("workos-social-"+alice.ID, "workos-"+alice.Email, "Initial", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.DB.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, workos.ID) })
	_, err = s.UpdateProfile(workos.ID, ProfileUpdate{Name: &name})
	if err != nil {
		t.Fatal(err)
	}
	s.SetAvatar(workos.ID, nil)
	remote := "https://provider.example/picture"
	workos, err = s.UpsertUser("workos-social-"+alice.ID, "workos-"+alice.Email, "Provider changed", &remote)
	if err != nil || workos.Name != name || workos.AvatarURL != nil {
		t.Fatalf("WorkOS overwrote custom fields: %+v %v", workos, err)
	}
}

func TestSocialGroupsIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 12)
	owner := users[0]
	for _, u := range users[1:] {
		socialFriend(t, s, owner.ID, u.ID)
	}
	group, err := s.CreateGroup(owner.ID, "Friends", []string{users[1].ID, users[2].ID})
	if err != nil || group.Kind != "group" {
		t.Fatalf("group create: %+v %v", group, err)
	}
	if _, err = s.RenameRoom(group.ID, users[1].ID, "Wrong"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("nonowner rename: %v", err)
	}
	if err = s.AddRoomMember(group.ID, users[1].ID, users[3].ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("nonowner invitation: %v", err)
	}
	if err = s.RemoveRoomMember(group.ID, users[1].ID, users[2].ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("nonowner removal: %v", err)
	}
	for _, u := range users[3:10] {
		if err = s.AddRoomMember(group.ID, owner.ID, u.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.AddRoomMember(group.ID, owner.ID, users[10].ID); !errors.Is(err, ErrGroupFull) {
		t.Fatalf("group capacity: %v", err)
	}
	if err = s.AddRoomMember(group.ID, owner.ID, users[1].ID); err != nil {
		t.Fatalf("existing member idempotency: %v", err)
	}
	members, _ := s.ListRoomMembers(group.ID)
	expected := members[0].User.ID
	var oldest time.Time
	for _, m := range members {
		if m.User.ID == owner.ID {
			continue
		}
		if oldest.IsZero() || m.JoinedAt.Before(oldest) || (m.JoinedAt.Equal(oldest) && m.User.ID < expected) {
			expected = m.User.ID
			oldest = m.JoinedAt
		}
	}
	if err = s.RemoveRoomMember(group.ID, owner.ID, owner.ID); err != nil {
		t.Fatal(err)
	}
	transferred, err := s.RoomForMember(group.ID, expected)
	if err != nil || transferred.OwnerID != expected || transferred.Role != "owner" {
		t.Fatalf("owner transfer: %+v %v", transferred, err)
	}
	if _, err = s.RoomForMember(group.ID, owner.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("left owner retained access")
	}
	// A new group cannot put two people together if either blocked the other.
	if _, err = s.BlockUser(users[10].ID, users[11].ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateGroup(owner.ID, "Blocked group", []string{users[10].ID, users[11].ID}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("blocked group: %v", err)
	}
	pair, err := s.CreateGroup(owner.ID, "Pair", []string{users[10].ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.BlockUser(owner.ID, users[10].ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.RoomForMember(pair.ID, owner.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("blocker stayed in common group")
	}
	remaining, err := s.RoomForMember(pair.ID, users[10].ID)
	if err != nil || remaining.Role != "owner" {
		t.Fatalf("block owner transfer: %+v %v", remaining, err)
	}
	if err = s.RemoveRoomMember(pair.ID, users[10].ID, users[10].ID); err != nil {
		t.Fatal(err)
	}
	var count int
	s.DB.QueryRow(context.Background(), `SELECT count(*) FROM rooms WHERE id=$1`, pair.ID).Scan(&count)
	if count != 0 {
		t.Fatal("empty group not deleted")
	}
}

func TestSocialInvitesIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 4)
	owner := users[0]
	room, err := s.CreateRoom(owner.ID, "Invite-only room")
	if err != nil {
		t.Fatal(err)
	}
	token, _ := randomToken()
	expires := time.Now().Add(time.Hour)
	invite, err := s.CreateInvite(room.ID, owner.ID, token, &expires, 1)
	if err != nil {
		t.Fatal(err)
	}
	var stored []byte
	s.DB.QueryRow(context.Background(), `SELECT token_hash FROM room_invites WHERE id=$1`, invite.ID).Scan(&stored)
	hash := sha256.Sum256([]byte(token))
	if !bytes.Equal(stored, hash[:]) || bytes.Equal(stored, []byte(token)) {
		t.Fatal("opaque token not hashed")
	}
	if _, err = s.CreateInvite(room.ID, users[1].ID, "unauthorized", nil, 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("nonowner creation: %v", err)
	}
	preview, err := s.PreviewInvite(token, users[1].ID)
	if err != nil || preview.RoomName != room.Name || preview.AlreadyMember || preview.RemainingUses == nil || *preview.RemainingUses != 1 {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, u := range users[1:3] {
		wg.Add(1)
		go func(id string) { defer wg.Done(); _, _, err := s.RedeemInvite(token, id); results <- err }(u.ID)
	}
	wg.Wait()
	close(results)
	success, unavailable := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrInviteUnavailable) {
			unavailable++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || unavailable != 1 {
		t.Fatalf("one-use race: %d/%d", success, unavailable)
	}
	members, _ := s.ListRoomMembers(room.ID)
	var winner string
	for _, m := range members {
		if m.User.ID != owner.ID {
			winner = m.User.ID
		}
	}
	_, added, err := s.RedeemInvite(token, winner)
	if err != nil || added {
		t.Fatalf("repeat redeem consumed use: %v/%v", added, err)
	}
	items, _ := s.ListInvites(room.ID, owner.ID)
	if len(items) != 1 || items[0].Uses != 1 {
		t.Fatalf("invitation uses: %+v", items)
	}
	if err = s.RevokeInvite(room.ID, users[3].ID, invite.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("nonowner revoke: %v", err)
	}
	if err = s.RevokeInvite(room.ID, owner.ID, invite.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.PreviewInvite(token, winner); !errors.Is(err, ErrInviteUnavailable) {
		t.Fatal("revoked preview remained")
	}
	expiredToken, _ := randomToken()
	past := time.Now().Add(-time.Second)
	s.CreateInvite(room.ID, owner.ID, expiredToken, &past, 0)
	if _, _, err = s.RedeemInvite(expiredToken, users[3].ID); !errors.Is(err, ErrInviteUnavailable) {
		t.Fatalf("expired redeem: %v", err)
	}
	blockedToken, _ := randomToken()
	s.CreateInvite(room.ID, owner.ID, blockedToken, nil, 0)
	s.BlockUser(users[3].ID, owner.ID)
	if _, _, err = s.RedeemInvite(blockedToken, users[3].ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("blocked redeem: %v", err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173"})
	req := httptest.NewRequest(http.MethodGet, "http://localhost:5173/api/v1/invites/"+token, nil)
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, req)
	if response.Code != 401 {
		t.Fatal("anonymous invitation preview allowed")
	}
	response = socialRequest(t, a, owner, "POST", "rooms/"+room.ID+"/invites", "application/json", []byte(`{}`))
	if response.Code != 201 {
		t.Fatal(response.Body)
	}
	var creation struct {
		URL   string `json:"url"`
		Token string `json:"token"`
	}
	json.Unmarshal(response.Body.Bytes(), &creation)
	if creation.URL != "http://localhost:5173#/?invite="+creation.Token {
		t.Fatalf("share URL: %q", creation.URL)
	}
}

func TestAccountDNDSuppressesQueuedAndNewPushIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 2)
	room, _ := s.CreateRoom(users[0].ID, "Push")
	socialFriend(t, s, users[0].ID, users[1].ID)
	if err := s.AddRoomMember(room.ID, users[0].ID, users[1].ID); err != nil {
		t.Fatal(err)
	}
	_, err := s.DB.Exec(context.Background(), `INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,$2,'key','auth')`, users[1].ID, "https://push.example/"+users[1].ID)
	if err != nil {
		t.Fatal(err)
	}
	s.WriteMessage(room.ID, users[0].ID, "", "before DND", "")
	if err = s.SetPresence(users[1].ID, "dnd"); err != nil {
		t.Fatal(err)
	}
	s.WriteMessage(room.ID, users[0].ID, "", "during DND", "")
	var count int
	s.DB.QueryRow(context.Background(), `SELECT count(*) FROM push_deliveries d JOIN push_subscriptions ps ON ps.id=d.subscription_id WHERE ps.user_id=$1`, users[1].ID).Scan(&count)
	if count != 0 {
		t.Fatalf("account DND retained/queued %d deliveries", count)
	}
	if status, err := s.Presence(users[1].ID); err != nil || status != "dnd" {
		t.Fatalf("persisted presence %s/%v", status, err)
	}
}

func TestChannelAdditionDoesNotLockUnrelatedMemberPairsIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 2)
	owner, target := users[0], users[1]
	socialFriend(t, s, owner.ID, target.ID)
	room, err := s.CreateRoom(owner.ID, "Large channel")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	prefix := "large-" + fmt.Sprint(time.Now().UnixNano()) + "-"
	t.Cleanup(func() { s.DB.Exec(ctx, `DELETE FROM users WHERE email LIKE $1`, prefix+"%") })
	// Actual channel roster size must not multiply pair locks in its add path.
	if _, err = s.DB.Exec(ctx, `INSERT INTO users(email,name) SELECT $1||n||'@example.test','Member '||n FROM generate_series(1,1000) n`, prefix); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `INSERT INTO room_members(room_id,user_id) SELECT $1,id FROM users WHERE email LIKE $2`, room.ID, prefix+"%"); err != nil {
		t.Fatal(err)
	}
	rows, err := s.DB.Query(ctx, `SELECT id::text FROM users WHERE email LIKE $1 ORDER BY id LIMIT 2`, prefix+"%")
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(ids) != 2 {
		t.Fatalf("fixture members %v %v", ids, err)
	}
	lock, err := s.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(ctx)
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, directPairKey(ids[0], ids[1])); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- s.AddRoomMember(room.ID, owner.ID, target.ID) }()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		lock.Rollback(ctx)
		t.Fatal("channel addition waited on unrelated member pair locks")
	}
	if _, err = s.RoomForMember(room.ID, target.ID); err != nil {
		t.Fatal("new channel member did not receive access")
	}
}

func TestActiveInvitationLimitAndHistoricalVisibilityIntegration(t *testing.T) {
	s := socialDatabase(t)
	owner := socialUsers(t, s, 1)[0]
	room, err := s.CreateRoom(owner.ID, "Many links")
	if err != nil {
		t.Fatal(err)
	}
	oldestToken, _ := randomToken()
	oldest, err := s.CreateInvite(room.ID, owner.ID, oldestToken, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	for i := 0; i < 110; i++ {
		token, _ := randomToken()
		if _, err = s.CreateInvite(room.ID, owner.ID, token, &past, 1); err != nil {
			t.Fatal(err)
		}
	}
	for i := 1; i < activeInviteLimit-1; i++ {
		token, _ := randomToken()
		if _, err = s.CreateInvite(room.ID, owner.ID, token, nil, 0); err != nil {
			t.Fatal(err)
		}
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, _ := randomToken()
			_, err := s.CreateInvite(room.ID, owner.ID, token, nil, 0)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success, limited := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrInviteLimit) {
			limited++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || limited != 1 {
		t.Fatalf("atomic active cap: %d successes, %d limits", success, limited)
	}
	invites, err := s.ListInvites(room.ID, owner.ID)
	if err != nil || len(invites) != 100 {
		t.Fatalf("bounded list: %d %v", len(invites), err)
	}
	found := false
	for _, invite := range invites[:activeInviteLimit] {
		if invite.ID == oldest.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("oldest still-active unlimited link hidden by expired history")
	}
	if err = s.RevokeInvite(room.ID, owner.ID, oldest.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.PreviewInvite(oldestToken, owner.ID); !errors.Is(err, ErrInviteUnavailable) {
		t.Fatal("oldest active link could not be revoked")
	}
	replacement, _ := randomToken()
	if _, err = s.CreateInvite(room.ID, owner.ID, replacement, nil, 0); err != nil {
		t.Fatalf("revocation did not free cap: %v", err)
	}
}
