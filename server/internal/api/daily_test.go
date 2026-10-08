package api

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"sync"
	"testing"
	"time"
)

func dailyJSON(t *testing.T, a *API, u User, method, path string, body any, want int) []byte {
	t.Helper()
	raw, _ := json.Marshal(body)
	r := socialRequest(t, a, u, method, path, "application/json", raw)
	if r.Code != want {
		t.Fatalf("%s %s => %d wanted %d: %s", method, path, r.Code, want, r.Body.String())
	}
	return r.Body.Bytes()
}
func TestDailyPreferenceValidation(t *testing.T) {
	valid := []string{`{"theme":"system"}`, `{"layout":"side","balanced":true,"sounds_enabled":false,"sound_volume":0,"sounds":{"join":true}}`}
	for _, v := range valid {
		var p map[string]json.RawMessage
		json.Unmarshal([]byte(v), &p)
		if !validatePreferencePatch(p) {
			t.Fatalf("rejected %s", v)
		}
	}
	invalid := []string{`{}`, `{"layout":"left"}`, `{"theme":"native"}`, `{"sound_volume":1.1}`, `{"balanced":null}`, `{"sounds_enabled":"false"}`, `{"sound_volume": null}`, `{"sounds":{"other":true}}`, `{"sounds":{"join":null}}`, `{"microphone":"global"}`}
	for _, v := range invalid {
		var p map[string]json.RawMessage
		json.Unmarshal([]byte(v), &p)
		if validatePreferencePatch(p) {
			t.Fatalf("accepted %s", v)
		}
	}
	now := time.Now()
	future := now.Add(time.Hour)
	old := now.Add(-time.Second)
	tooLate := now.Add(31 * 24 * time.Hour)
	for _, v := range []CustomStatus{{Text: "Playing", Emoji: "🎮", ExpiresAt: &future}, {Emoji: "😀"}, {}} {
		if !validCustomStatus(v, now) {
			t.Fatalf("rejected valid status %+v", v)
		}
	}
	for _, v := range []CustomStatus{{Text: string(bytes.Repeat([]byte("a"), 101))}, {Text: "hidden\nline"}, {Emoji: "not emoji"}, {ExpiresAt: &old}, {ExpiresAt: &tooLate}} {
		if validCustomStatus(v, now) {
			t.Fatalf("accepted invalid status %+v", v)
		}
	}
}
func TestDailyPublicProfileAndStatusIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 4)
	alice, bob, mutual, outsider := users[0], users[1], users[2], users[3]
	socialFriend(t, s, alice.ID, bob.ID)
	socialFriend(t, s, alice.ID, mutual.ID)
	socialFriend(t, s, bob.ID, mutual.ID)
	room, e := s.CreateRoom(alice.ID, "Shared visible room")
	if e != nil {
		t.Fatal(e)
	}
	if e = s.AddRoomMember(room.ID, alice.ID, bob.ID); e != nil {
		t.Fatal(e)
	}
	private, e := s.CreateRoom(bob.ID, "Private hidden room")
	if e != nil {
		t.Fatal(e)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173", DevAuth: true})
	expires := time.Now().Add(time.Hour)
	data := dailyJSON(t, a, bob, "PUT", "me/status", map[string]any{"status": CustomStatus{Text: "Playing", Emoji: "🎮", ExpiresAt: &expires}}, 200)
	var status StatusSnapshot
	if e = json.Unmarshal(data, &status); e != nil {
		t.Fatal(e)
	}
	friends, _, e := s.ListFriends(alice.ID)
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, friend := range friends {
		if friend.ID == bob.ID && friend.CustomStatus != nil && friend.CustomStatus.Text == "Playing" && friend.StatusVersion == status.Version {
			found = true
		}
	}
	if !found {
		t.Fatal("persisted friend status absent on initial load")
	}
	data = dailyJSON(t, a, bob, "GET", "me", nil, 200)
	if !bytes.Contains(data, []byte(`"custom_status"`)) || !bytes.Contains(data, []byte(`"Playing"`)) {
		t.Fatal("own persisted customstatus missing")
	}
	data = dailyJSON(t, a, alice, "GET", "users/"+bob.ID+"/profile", nil, 200)
	if bytes.Contains(data, []byte("email")) || bytes.Contains(data, []byte("presence_status")) || bytes.Contains(data, []byte(private.Name)) {
		t.Fatalf("profile disclosed private fields: %s", data)
	}
	var profile UserProfile
	if e = json.Unmarshal(data, &profile); e != nil {
		t.Fatal(e)
	}
	if profile.Relationship != "friend" || profile.Presence != "offline" || len(profile.SharedRooms) != 1 || len(profile.MutualFriends) != 1 || profile.MutualFriends[0].ID != mutual.ID || profile.User.CustomStatus.Text != "Playing" {
		t.Fatalf("profile %+v", profile)
	}
	dailyJSON(t, a, outsider, "GET", "users/"+bob.ID+"/profile", nil, 404)
	request, e := s.CreateFriendRequest(alice.ID, outsider.ID)
	if e != nil {
		t.Fatal(e)
	}
	data = dailyJSON(t, a, outsider, "GET", "users/"+alice.ID+"/profile", nil, 200)
	json.Unmarshal(data, &profile)
	if profile.Relationship != "incoming_request" || profile.FriendRequestID != request.ID {
		t.Fatalf("pending profile %+v", profile)
	}
	// Expiry is effective even before the bounded background sweep executes.
	if _, e = s.DB.Exec(context.Background(), `UPDATE user_custom_status SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1`, bob.ID); e != nil {
		t.Fatal(e)
	}
	expired, e := s.CustomStatus(bob.ID)
	if e != nil || expired.Status.Text != "" || expired.Version != status.Version {
		t.Fatalf("expired %+v %v", expired, e)
	}
	if e = a.ExpireCustomStatuses(context.Background()); e != nil {
		t.Fatal(e)
	}
	expired, e = s.CustomStatus(bob.ID)
	if e != nil || expired.Version != status.Version+1 {
		t.Fatalf("sweep %+v %v", expired, e)
	}
	if _, e = s.BlockUser(alice.ID, bob.ID); e != nil {
		t.Fatal(e)
	}
	dailyJSON(t, a, alice, "GET", "users/"+bob.ID+"/profile", nil, 404)
	recipients, e := s.StatusRecipients(bob.ID)
	if e != nil {
		t.Fatal(e)
	}
	for _, id := range recipients {
		if id == alice.ID {
			t.Fatal("blocked contact received status")
		}
	}
}
func TestDailyPreferencesConcurrencyIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 2)
	alice, bob := users[0], users[1]
	socialFriend(t, s, alice.ID, bob.ID)
	dm, e := s.CreateDirectRoom(alice.ID, bob.ID)
	if e != nil {
		t.Fatal(e)
	}
	channel, e := s.CreateRoom(alice.ID, "Preferences")
	if e != nil {
		t.Fatal(e)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173", DevAuth: true})
	dailyJSON(t, a, alice, "PUT", "rooms/"+channel.ID+"/preferences", map[string]bool{"archived": true}, 403)
	dailyJSON(t, a, bob, "PUT", "rooms/"+channel.ID+"/preferences", map[string]bool{"favorite": true}, 403)
	dailyJSON(t, a, alice, "PUT", "rooms/"+dm.ID+"/preferences", map[string]any{"favorite": true, "device": "global"}, 400)
	enabled := true
	var wait sync.WaitGroup
	errs := make(chan error, 2)
	wait.Add(2)
	go func() {
		defer wait.Done()
		_, e := s.SetConversationPreference(dm.ID, alice.ID, &enabled, nil)
		errs <- e
	}()
	go func() {
		defer wait.Done()
		_, e := s.SetConversationPreference(dm.ID, alice.ID, nil, &enabled)
		errs <- e
	}()
	wait.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	values, e := s.ConversationPreferences(alice.ID)
	if e != nil || !values[dm.ID].Favorite || !values[dm.ID].Archived || values[dm.ID].Version != 2 {
		t.Fatalf("partial concurrent prefs %+v %v", values, e)
	}
	others, e := s.ConversationPreferences(bob.ID)
	if e != nil || len(others) != 0 {
		t.Fatal("preferences leaked across accounts")
	}
	results := make(chan error, 2)
	wait.Add(2)
	for _, theme := range []string{"dark", "light"} {
		go func(v string) {
			defer wait.Done()
			_, e := s.PatchAccountPreferences(alice.ID, 0, map[string]json.RawMessage{"theme": json.RawMessage(fmt.Sprintf("%q", v))})
			results <- e
		}(theme)
	}
	wait.Wait()
	close(results)
	success, conflicts := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if errors.Is(e, ErrConflict) {
			conflicts++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("optimistic concurrency success%d conflict%d", success, conflicts)
	}
	dailyJSON(t, a, alice, "PATCH", "me/preferences", map[string]any{"version": 0, "settings": map[string]any{"layout": "side"}}, 409)
	prefs, e := s.AccountPreferences(alice.ID)
	if e != nil {
		t.Fatal(e)
	}
	prefs, e = s.PatchAccountPreferences(alice.ID, prefs.Version, map[string]json.RawMessage{"sounds": json.RawMessage(`{"join":false}`)})
	if e != nil {
		t.Fatal(e)
	}
	prefs, e = s.PatchAccountPreferences(alice.ID, prefs.Version, map[string]json.RawMessage{"sounds": json.RawMessage(`{"leave":false}`)})
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Contains(prefs.Settings["sounds"], []byte("join")) || !bytes.Contains(prefs.Settings["sounds"], []byte("leave")) {
		t.Fatal("sparse sounds update discarded prior device edit")
	}
}
func TestDailyStatusExpiryHonorsFanoutDeadlineIntegration(t *testing.T) {
	s := socialDatabase(t)
	user := socialUsers(t, s, 1)[0]
	old := time.Now().Add(-time.Second)
	if _, e := s.SetCustomStatus(user.ID, CustomStatus{Text: "Expired", ExpiresAt: &old}); e != nil {
		t.Fatal(e)
	}
	tx, e := s.DB.Begin(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(context.Background())
	if _, e = tx.Exec(context.Background(), `LOCK TABLE users IN ACCESS EXCLUSIVE MODE`); e != nil {
		t.Fatal(e)
	}
	a := New(s, Sessions{Store: s}, Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	e = a.ExpireCustomStatuses(ctx)
	if !errors.Is(e, context.DeadlineExceeded) || time.Since(started) > time.Second {
		t.Fatalf("expiry fanout escaped deadline: %v %v", e, time.Since(started))
	}
	released := make(chan struct{})
	go func() { a.accessMu.Lock(); a.accessMu.Unlock(); close(released) }()
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("expiry fanout retained lifecycle read lock after cancellation")
	}
}
func TestDailyStatusSweepDoesNotBlockLifecycleMutation(t *testing.T) {
	a := New(&PostgresStore{}, Sessions{}, Config{})
	a.accessMu.Lock()
	defer a.accessMu.Unlock()
	started := time.Now()
	if e := a.ExpireCustomStatuses(context.Background()); e != nil || time.Since(started) > time.Second {
		t.Fatalf("maintenance queued behind lifecycle mutation: %v", e)
	}
}
func TestDailyActivityPaginationAndAuthorizationIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 3)
	alice, bob, outsider := users[0], users[1], users[2]
	socialFriend(t, s, alice.ID, bob.ID)
	room, e := s.CreateRoom(alice.ID, "Activity")
	if e != nil {
		t.Fatal(e)
	}
	if e = s.AddRoomMember(room.ID, alice.ID, bob.ID); e != nil {
		t.Fatal(e)
	}
	root, e := s.WriteMessage(room.ID, alice.ID, "", "Root", "")
	if e != nil {
		t.Fatal(e)
	}
	mention, e := s.WriteMessage(room.ID, bob.ID, "", "Reply <@"+alice.ID+">", root.ID)
	if e != nil {
		t.Fatal(e)
	}
	reply, e := s.WriteMessage(room.ID, bob.ID, "", "Other reply", root.ID)
	if e != nil {
		t.Fatal(e)
	}
	thread, _, e := s.SendThreadMessage(room.ID, bob.ID, "Thread reply", "", "", nil, root.ID)
	if e != nil {
		t.Fatal(e)
	}
	request, e := s.CreateFriendRequest(outsider.ID, alice.ID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.DB.Exec(context.Background(), `UPDATE messages SET created_at='2026-09-01T00:00:00Z' WHERE room_id=$1;`, room.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = s.DB.Exec(context.Background(), `UPDATE friend_requests SET created_at='2026-09-01T00:00:00Z' WHERE id=$1`, request.ID); e != nil {
		t.Fatal(e)
	}
	seen := map[string]bool{}
	var cursor activityCursor
	for i := 0; i < 10; i++ {
		page, e := s.Activity(alice.ID, "all", cursor, 2)
		if e != nil {
			t.Fatal(e)
		}
		for _, v := range page.Items {
			if seen[v.ID] {
				t.Fatal("duplicate paged activity")
			}
			seen[v.ID] = true
			if v.Message != nil && v.Message.ID == mention.ID && v.Kind != "mention" {
				t.Fatal("reply and mention duplicated")
			}
		}
		if page.NextCursor == "" {
			break
		}
		last := page.Items[len(page.Items)-1]
		cursor = activityCursor{Time: last.CreatedAt, ID: last.ID}
	}
	if len(seen) != 4 || !seen["reply:"+thread.ID] || !seen["reply:"+reply.ID] || !seen["mention:"+mention.ID] || !seen["friend_request:"+request.ID] {
		t.Fatalf("activity gap %+v", seen)
	}
	replies, e := s.Activity(alice.ID, "replies", activityCursor{}, 30)
	if e != nil {
		t.Fatal(e)
	}
	mentionedReply := false
	for _, item := range replies.Items {
		if item.Message != nil && item.Message.ID == mention.ID && item.Kind == "reply" {
			mentionedReply = true
		}
	}
	if !mentionedReply {
		t.Fatal("replies filter lost a reply that also mentioned the viewer")
	}
	if e = s.ReadRoom(room.ID, alice.ID, reply.ID); e != nil {
		t.Fatal(e)
	}
	page, e := s.Activity(alice.ID, "all", activityCursor{}, 30)
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range page.Items {
		if v.Message != nil && v.Message.ID == thread.ID && (v.Read || v.Message.ThreadRootID == nil) {
			t.Fatal("thread read scope lost")
		}
		if v.Message != nil && v.Message.ID == mention.ID && !v.Read {
			t.Fatal("main read cursor ignored")
		}
	}
	if _, e = s.DeleteMessage(room.ID, bob.ID, mention.ID); e != nil {
		t.Fatal(e)
	}
	if e = s.RemoveRoomMember(room.ID, alice.ID, bob.ID); e != nil {
		t.Fatal(e)
	}
	page, e = s.Activity(bob.ID, "all", activityCursor{}, 30)
	if e != nil || len(page.Items) != 0 {
		t.Fatalf("revoked room retained activity %+v %v", page, e)
	}
	if _, e = s.BlockUser(alice.ID, outsider.ID); e != nil {
		t.Fatal(e)
	}
	page, e = s.Activity(alice.ID, "requests", activityCursor{}, 30)
	if e != nil || len(page.Items) != 0 {
		t.Fatal("blocked pending request remained in activity")
	}
}
func TestDailyActivityThreadReplyRecipientsIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 3)
	alice, bob, charlie := users[0], users[1], users[2]
	socialFriend(t, s, alice.ID, bob.ID)
	socialFriend(t, s, alice.ID, charlie.ID)
	room, err := s.CreateRoom(alice.ID, "Thread activity recipients")
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []User{bob, charlie} {
		if err = s.AddRoomMember(room.ID, alice.ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	root, err := s.WriteMessage(room.ID, alice.ID, "", "Alice's thread", "")
	if err != nil {
		t.Fatal(err)
	}
	send := func(user User, body, replyID string) Message {
		t.Helper()
		message, _, err := s.SendThreadMessage(room.ID, user.ID, body, replyID, "", nil, root.ID)
		if err != nil {
			t.Fatal(err)
		}
		return message
	}
	bobMessage := send(bob, "Bob joins Alice's thread", "")
	quotedBob := send(charlie, "Reply to Bob in Alice's thread", bobMessage.ID)
	aliceMessage := send(alice, "Alice joins her thread", "")
	quotedAlice := send(charlie, "Both recipient links belong to Alice", aliceMessage.ID)
	mentionedAlice := send(charlie, "Reply to Bob and mention <@"+alice.ID+">", bobMessage.ID)
	expectActivity := func(user User, kind string, wanted map[string]string) {
		t.Helper()
		page, err := s.Activity(user.ID, kind, activityCursor{}, 30)
		if err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for _, item := range page.Items {
			if item.Message == nil {
				t.Fatalf("unexpected non-message activity for %s/%s: %+v", user.Name, kind, item)
			}
			id := item.Message.ID
			if seen[id] {
				t.Fatalf("duplicate thread reply for %s/%s: %s", user.Name, kind, id)
			}
			seen[id] = true
			if wanted[id] != item.Kind || item.RoomID != room.ID || item.Message.ThreadRootID == nil || *item.Message.ThreadRootID != root.ID {
				t.Fatalf("unexpected activity for %s/%s: %+v", user.Name, kind, item)
			}
		}
		if len(seen) != len(wanted) {
			t.Fatalf("missing thread activity for %s/%s: got %v, want %v", user.Name, kind, seen, wanted)
		}
	}
	allAlice := map[string]string{bobMessage.ID: "reply", quotedBob.ID: "reply", quotedAlice.ID: "reply", mentionedAlice.ID: "mention"}
	repliesAlice := map[string]string{bobMessage.ID: "reply", quotedBob.ID: "reply", quotedAlice.ID: "reply", mentionedAlice.ID: "reply"}
	bobActivity := map[string]string{quotedBob.ID: "reply", mentionedAlice.ID: "reply"}
	for _, kind := range []string{"all", "replies"} {
		wanted := allAlice
		if kind == "replies" {
			wanted = repliesAlice
		}
		expectActivity(alice, kind, wanted)
		expectActivity(bob, kind, bobActivity)
		expectActivity(charlie, kind, nil)
	}
	if _, err = s.DeleteMessage(room.ID, charlie.ID, quotedBob.ID); err != nil {
		t.Fatal(err)
	}
	delete(allAlice, quotedBob.ID)
	delete(repliesAlice, quotedBob.ID)
	delete(bobActivity, quotedBob.ID)
	expectActivity(alice, "all", allAlice)
	expectActivity(alice, "replies", repliesAlice)
	expectActivity(bob, "replies", bobActivity)
	if _, err = s.BlockUser(alice.ID, charlie.ID); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"all", "replies"} {
		expectActivity(alice, kind, map[string]string{bobMessage.ID: "reply"})
	}
	if err = s.RemoveRoomMember(room.ID, alice.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"all", "replies"} {
		expectActivity(bob, kind, nil)
	}
}
func voiceEBML(id []byte, body []byte) []byte {
	out := append([]byte{}, id...)
	if len(body) < 127 {
		out = append(out, byte(0x80|len(body)))
	} else {
		out = append(out, byte(0x40|len(body)>>8), byte(len(body)))
	}
	return append(out, body...)
}
func voiceWebMFixture(trackType byte) []byte {
	header := voiceEBML([]byte{0x1a, 0x45, 0xdf, 0xa3}, voiceEBML([]byte{0x42, 0x82}, []byte("webm")))
	entry := append(voiceEBML([]byte{0xd7}, []byte{1}), voiceEBML([]byte{0x83}, []byte{trackType})...)
	entry = append(entry, voiceEBML([]byte{0x86}, []byte("A_OPUS"))...)
	tracks := voiceEBML([]byte{0x16, 0x54, 0xae, 0x6b}, voiceEBML([]byte{0xae}, entry))
	cluster := voiceEBML([]byte{0x1f, 0x43, 0xb6, 0x75}, append(voiceEBML([]byte{0xe7}, []byte{0}), voiceEBML([]byte{0xa3}, []byte{0x81, 0x03, 0xe8, 0, 0xf8, 0xff, 0xfe})...))
	return append(header, voiceEBML([]byte{0x18, 0x53, 0x80, 0x67}, append(tracks, cluster...))...)
}
func voiceMP4Box(kind string, body []byte) []byte {
	out := make([]byte, 8)
	binary.BigEndian.PutUint32(out, uint32(len(body)+8))
	copy(out[4:], kind)
	return append(out, body...)
}
func voiceMP4Fixture(handler string) []byte {
	h := make([]byte, 12)
	copy(h[8:], handler)
	mdhd := make([]byte, 24)
	binary.BigEndian.PutUint32(mdhd[12:], 1000)
	binary.BigEndian.PutUint32(mdhd[16:], 1000)
	stsd := make([]byte, 8)
	binary.BigEndian.PutUint32(stsd[4:], 1)
	stsd = append(stsd, voiceMP4Box("mp4a", make([]byte, 28))...)
	mdia := append(voiceMP4Box("hdlr", h), voiceMP4Box("mdhd", mdhd)...)
	mdia = append(mdia, voiceMP4Box("minf", voiceMP4Box("stbl", voiceMP4Box("stsd", stsd)))...)
	track := voiceMP4Box("trak", voiceMP4Box("mdia", mdia))
	out := append(voiceMP4Box("ftyp", []byte("isom\x00\x00\x00\x00")), voiceMP4Box("moov", track)...)
	return append(out, voiceMP4Box("mdat", []byte{1, 2, 3, 4})...)
}
func fragmentedVoiceMP4Fixture(start uint64, count uint32, sampleFlags uint32, trexDefault bool) []byte {
	h := make([]byte, 12)
	copy(h[8:], "soun")
	mdhd := make([]byte, 24)
	binary.BigEndian.PutUint32(mdhd[12:], 1000)
	tkhd := make([]byte, 24)
	binary.BigEndian.PutUint32(tkhd[12:], 1)
	stsd := make([]byte, 8)
	binary.BigEndian.PutUint32(stsd[4:], 1)
	stsd = append(stsd, voiceMP4Box("mp4a", make([]byte, 28))...)
	mdia := append(voiceMP4Box("hdlr", h), voiceMP4Box("mdhd", mdhd)...)
	mdia = append(mdia, voiceMP4Box("minf", voiceMP4Box("stbl", voiceMP4Box("stsd", stsd)))...)
	moov := voiceMP4Box("trak", append(voiceMP4Box("tkhd", tkhd), voiceMP4Box("mdia", mdia)...))
	if trexDefault {
		trex := make([]byte, 24)
		binary.BigEndian.PutUint32(trex[4:], 1)
		binary.BigEndian.PutUint32(trex[12:], 1000)
		moov = append(moov, voiceMP4Box("mvex", voiceMP4Box("trex", trex))...)
	}
	tfhd := make([]byte, 20)
	binary.BigEndian.PutUint32(tfhd, 3)
	binary.BigEndian.PutUint32(tfhd[4:], 1)
	if !trexDefault {
		binary.BigEndian.PutUint32(tfhd, 11)
		tfhd = append(tfhd, 0, 0, 3, 0xe8)
	}
	tfdt := make([]byte, 12)
	tfdt[0] = 1
	binary.BigEndian.PutUint64(tfdt[4:], start)
	trun := make([]byte, 8)
	binary.BigEndian.PutUint32(trun, sampleFlags)
	binary.BigEndian.PutUint32(trun[4:], count)
	if sampleFlags&1 != 0 {
		trun = append(trun, 0, 0, 0, 0)
	}
	if sampleFlags&4 != 0 {
		trun = append(trun, 0, 0, 0, 0)
	}
	for i := uint32(0); i < count; i++ {
		for _, flag := range []uint32{0x100, 0x200, 0x400, 0x800} {
			if sampleFlags&flag != 0 {
				value := make([]byte, 4)
				if flag == 0x100 {
					binary.BigEndian.PutUint32(value, 1000)
				}
				trun = append(trun, value...)
			}
		}
	}
	traf := append(voiceMP4Box("tfhd", tfhd), voiceMP4Box("tfdt", tfdt)...)
	traf = append(traf, voiceMP4Box("trun", trun)...)
	out := append(voiceMP4Box("ftyp", []byte("isom\x00\x00\x00\x00")), voiceMP4Box("moov", moov)...)
	out = append(out, voiceMP4Box("moof", voiceMP4Box("traf", traf))...)
	return append(out, voiceMP4Box("mdat", []byte{1, 2, 3, 4})...)
}
func TestDailyFragmentedVoiceMP4Clock(t *testing.T) {
	for _, fixture := range [][]byte{fragmentedVoiceMP4Fixture(0, 1, 0, true), fragmentedVoiceMP4Fixture(0, 1, 0, false), fragmentedVoiceMP4Fixture(0, 1, 0xf05, true)} {
		if mime, e := validateVoiceNote(fixture, 1000); e != nil || mime != "audio/mp4" {
			t.Fatalf("fragmented audio duration rejected %s %v", mime, e)
		}
	}
	for _, fixture := range [][]byte{fragmentedVoiceMP4Fixture(0, 121, 0, true), fragmentedVoiceMP4Fixture(150000, 1, 0, true), fragmentedVoiceMP4Fixture(0, 1, 0, true)[:40]} {
		if _, e := validateVoiceNote(fixture, 120000); e == nil {
			t.Fatal("accepted over-limit or malformed fragmented voice note")
		}
	}
	for _, composition := range []struct {
		version byte
		offset  uint32
	}{{0, 300000}, {1, 0xffffffff}} {
		fixture := fragmentedVoiceMP4Fixture(0, 1, 0xf05, true)
		position := bytes.Index(fixture, []byte("trun"))
		if position < 4 {
			t.Fatal("fixture missing samples")
		}
		size := int(binary.BigEndian.Uint32(fixture[position-4 : position]))
		fixture[position+4] = composition.version
		binary.BigEndian.PutUint32(fixture[position-4+size-4:], composition.offset)
		if _, e := validateVoiceNote(fixture, 1000); e == nil {
			t.Fatal("accepted nonzero audio composition offset")
		}
	}
	// A zero mdhd duration without a fragment clock cannot prove the time bound.
	unknown := voiceMP4Fixture("soun")
	needle := []byte("mdhd")
	position := bytes.Index(unknown, needle)
	if position < 0 {
		t.Fatal("fixture missing clock")
	}
	binary.BigEndian.PutUint32(unknown[position+4+16:], 0)
	if _, e := validateVoiceNote(unknown, 1000); e == nil {
		t.Fatal("accepted MP4 without a duration clock")
	}
}
func TestDailyVoiceContainers(t *testing.T) {
	for _, v := range []struct {
		data []byte
		mime string
	}{{voiceWebMFixture(2), "audio/webm"}, {voiceMP4Fixture("soun"), "audio/mp4"}} {
		mime, e := validateVoiceNote(v.data, 1000)
		if e != nil || mime != v.mime {
			t.Fatalf("valid audio rejected %s %v", mime, e)
		}
	}
	for _, v := range [][]byte{voiceWebMFixture(1), voiceMP4Fixture("vide"), []byte("audio/mp4 not real data"), voiceWebMFixture(2)[:20], append(voiceMP4Fixture("soun"), []byte{1}...)} {
		if _, e := validateVoiceNote(v, 1000); e == nil {
			t.Fatal("accepted malformed/video container")
		}
	}
	if _, e := validateVoiceNote(voiceWebMFixture(2), 120001); e == nil {
		t.Fatal("accepted recording over two minutes")
	}
	if _, e := validateVoiceNote(voiceWebMFixture(2), 60000); e == nil {
		t.Fatal("accepted false duration claim")
	}
	// MediaRecorder emits a segment and successive clusters with unknown sizes.
	// Boundaries must be parsed as siblings rather than recursive nested masters.
	header := voiceEBML([]byte{0x1a, 0x45, 0xdf, 0xa3}, voiceEBML([]byte{0x42, 0x82}, []byte("webm")))
	entry := append(voiceEBML([]byte{0xd7}, []byte{1}), voiceEBML([]byte{0x83}, []byte{2})...)
	entry = append(entry, voiceEBML([]byte{0x86}, []byte("A_OPUS"))...)
	stream := append(header, []byte{0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}...)
	stream = append(stream, voiceEBML([]byte{0x16, 0x54, 0xae, 0x6b}, voiceEBML([]byte{0xae}, entry))...)
	for i := 0; i < 20; i++ {
		stamp := make([]byte, 4)
		binary.BigEndian.PutUint32(stamp, uint32(i*5000))
		stream = append(stream, []byte{0x1f, 0x43, 0xb6, 0x75, 0xff}...)
		stream = append(stream, voiceEBML([]byte{0xe7}, stamp)...)
		stream = append(stream, voiceEBML([]byte{0xa3}, []byte{0x81, 0, 0, 0, 0xf8, 0xff, 0xfe})...)
	}
	if mime, e := validateVoiceNote(stream, 95000); e != nil || mime != "audio/webm" {
		t.Fatalf("streaming cluster boundaries %s %v", mime, e)
	}
}
func TestDailyVoiceAttachmentLifecycleIntegration(t *testing.T) {
	// Cleanup sweeps the whole schema; isolate this fixture from other tests
	// and the development API's cleanup worker.
	s := conversationTestStore(t)
	users := socialUsers(t, s, 2)
	alice, bob := users[0], users[1]
	socialFriend(t, s, alice.ID, bob.ID)
	room, e := s.CreateRoom(alice.ID, "Voice notes")
	if e != nil {
		t.Fatal(e)
	}
	if e = s.AddRoomMember(room.ID, alice.ID, bob.ID); e != nil {
		t.Fatal(e)
	}
	invalidID, _ := randomAttachmentID()
	if e = s.SavePendingAttachment(room.ID, alice.ID, "messages/"+invalidID, MessageAttachment{ID: invalidID, Filename: "voice.webm", ContentType: "audio/webm", SizeBytes: 1, VoiceNote: true}); e == nil {
		t.Fatal("database accepted voice note with NULL duration")
	}
	storage := &fakeAttachmentStorage{}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173", DevAuth: true})
	a.Attachments = storage
	upload := func(data []byte, want int) MessageAttachment {
		t.Helper()
		var body bytes.Buffer
		m := multipart.NewWriter(&body)
		file, _ := m.CreateFormFile("file", "voice.webm")
		file.Write(data)
		m.WriteField("voice_note", "true")
		m.WriteField("duration_ms", "1000")
		m.Close()
		r := socialRequest(t, a, alice, "POST", "rooms/"+room.ID+"/attachments", m.FormDataContentType(), body.Bytes())
		if r.Code != want {
			t.Fatalf("upload %d %s", r.Code, r.Body.String())
		}
		var response struct {
			Attachment MessageAttachment `json:"attachment"`
		}
		json.Unmarshal(r.Body.Bytes(), &response)
		return response.Attachment
	}
	upload(voiceWebMFixture(1), 415)
	if storage.putCount != 0 || len(storage.deleted) != 0 {
		t.Fatalf("invalid recording reached S3: puts=%d deleted=%v", storage.putCount, storage.deleted)
	}
	attachment := upload(voiceWebMFixture(2), 201)
	if !attachment.VoiceNote || attachment.DurationMS == nil || *attachment.DurationMS != 1000 || attachment.ContentType != "audio/webm" {
		t.Fatalf("metadata %+v", attachment)
	}
	m, _, e := s.SendMessage(room.ID, alice.ID, "", "", "", []string{attachment.ID})
	if e != nil || len(m.Attachments) != 1 || !m.Attachments[0].VoiceNote {
		t.Fatalf("message attachment %+v %v", m, e)
	}
	if _, _, e = s.AttachmentForMember(room.ID, bob.ID, attachment.ID); e != nil {
		t.Fatal(e)
	}
	if e = s.RemoveRoomMember(room.ID, alice.ID, bob.ID); e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.AttachmentForMember(room.ID, bob.ID, attachment.ID); e == nil {
		t.Fatal("revoked membership retained recording access")
	}
	if _, e = s.DeleteMessage(room.ID, alice.ID, m.ID); e != nil {
		t.Fatal(e)
	}
	if e = s.CleanPendingAttachments(context.Background(), storage); e != nil {
		t.Fatal(e)
	}
	key := "messages/" + attachment.ID
	if len(storage.deleted) != 1 || storage.deleted[0] != key {
		t.Fatalf("deleted voice recording cleanup: deleted=%v wanted=[%s]", storage.deleted, key)
	}
	var remaining int
	if e = s.DB.QueryRow(context.Background(), `SELECT count(*) FROM message_attachments WHERE id=$1`, attachment.ID).Scan(&remaining); e != nil || remaining != 0 {
		t.Fatalf("deleted recording retained its attachment row: remaining=%d error=%v", remaining, e)
	}
}
