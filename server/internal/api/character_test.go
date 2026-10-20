package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCharacterAppearanceBounds(t *testing.T) {
	for _, variant := range []int{-1, 0, 1, 5, 6} {
		for _, hue := range []int{-1, 0, 180, 359, 360} {
			value := hue
			got := validCharacter(CharacterAppearance{Variant: variant, Hue: &value})
			want := variant >= 0 && variant <= 5 && hue >= 0 && hue <= 359
			if got != want {
				t.Fatalf("variant %d hue %d: got %v want %v", variant, hue, got, want)
			}
		}
	}
	if !validCharacter(CharacterAppearance{}) {
		t.Fatal("original character rejected")
	}
}

func assertCharacter(t *testing.T, got CharacterAppearance, variant int, hue *int) {
	t.Helper()
	if got.Variant != variant || (got.Hue == nil) != (hue == nil) || hue != nil && *got.Hue != *hue {
		t.Fatalf("appearance: got %+v want variant %d hue %v", got, variant, hue)
	}
}

func characterClient(a *API, user User, rooms []Room, friends []User) *realtimeClient {
	c := &realtimeClient{user: user.ID, send: make(chan wire, 64)}
	a.Realtime.add(c, rooms, friends)
	return c
}

func TestCharacterPersistenceAndPublicSnapshotsIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 4)
	alice, bob, pending, outsider := users[0], users[1], users[2], users[3]
	socialFriend(t, s, alice.ID, bob.ID)
	community, err := s.CreateCommunity(alice.ID, "Characters", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.AddCommunityMember(community.ID, alice.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateFriendRequest(alice.ID, pending.ID); err != nil {
		t.Fatal(err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173"})
	room := community.Channels[0]
	own := characterClient(a, alice, []Room{room}, nil)
	friend := characterClient(a, bob, []Room{room}, []User{alice})
	stranger := characterClient(a, outsider, nil, nil)
	response := socialRequest(t, a, alice, "PATCH", "me/character", "application/json", []byte(`{"variant":4,"hue":248}`))
	if response.Code != 200 {
		t.Fatalf("save character: %d %s", response.Code, response.Body)
	}
	var data struct{ User User }
	if err = json.Unmarshal(response.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	hue := 248
	assertCharacter(t, data.User.Character, 4, &hue)
	if data.User.ID != alice.ID || data.User.Name != alice.Name || data.User.AvatarURL != nil || data.User.ProfileVersion != 1 {
		t.Fatalf("appearance altered profile identity: %+v", data.User)
	}
	for _, client := range []*realtimeClient{own, friend} {
		if len(client.send) != 1 {
			t.Fatalf("profile fanout count: %d", len(client.send))
		}
		event := <-client.send
		if event.Type != "user.profile" || json.Unmarshal(event.Payload, &data) != nil {
			t.Fatalf("profile event: %+v", event)
		}
		assertCharacter(t, data.User.Character, 4, &hue)
	}
	if len(stranger.send) != 0 {
		t.Fatal("character update leaked to outsider")
	}
	dev, err := s.UpsertDevUser(alice.Email, "Provider name")
	if err != nil {
		t.Fatal(err)
	}
	assertCharacter(t, dev.Character, 4, &hue)
	friends, _, err := s.ListFriends(bob.ID)
	if err != nil || len(friends) != 1 {
		t.Fatalf("friends snapshot: %+v %v", friends, err)
	}
	assertCharacter(t, friends[0].Character, 4, &hue)
	members, err := s.ListRoomMembers(room.ID)
	if err != nil || len(members) != 2 {
		t.Fatalf("room snapshot: %+v %v", members, err)
	}
	communityMembers, err := s.CommunityMembers(community.ID, bob.ID)
	if err != nil || len(communityMembers) != 2 {
		t.Fatalf("community snapshot: %+v %v", communityMembers, err)
	}
	for _, list := range [][]RoomMember{members, communityMembers} {
		for _, member := range list {
			if member.User.ID == alice.ID {
				assertCharacter(t, member.User.Character, 4, &hue)
			}
		}
	}
	profile, err := s.PublicProfile(alice.ID, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertCharacter(t, profile.User.Character, 4, &hue)
	if _, err = s.PublicProfile(alice.ID, outsider.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider read profile: %v", err)
	}
	message, err := s.WriteMessage(room.ID, alice.ID, "", "My character", "")
	if err != nil {
		t.Fatal(err)
	}
	assertCharacter(t, message.Author.Character, 4, &hue)
	page, err := s.MessagePage(room.ID, bob.ID, "", 10)
	if err != nil || len(page.Messages) != 1 {
		t.Fatalf("message snapshot: %+v %v", page, err)
	}
	assertCharacter(t, page.Messages[0].Author.Character, 4, &hue)
	legacy, err := s.ListMessages(room.ID, time.Now().Add(time.Second), 10)
	if err != nil || len(legacy) != 1 {
		t.Fatalf("legacy message snapshot: %+v %v", legacy, err)
	}
	assertCharacter(t, legacy[0].Author.Character, 4, &hue)
	activity, err := s.Activity(pending.ID, "requests", activityCursor{}, 10)
	if err != nil || len(activity.Items) != 1 || activity.Items[0].FriendRequest == nil {
		t.Fatalf("friend request activity: %+v %v", activity, err)
	}
	assertCharacter(t, activity.Items[0].FriendRequest.Sender.Character, 4, &hue)
	_, requests, err := s.ListFriends(pending.ID)
	if err != nil || len(requests) != 1 {
		t.Fatalf("friend requests: %+v %v", requests, err)
	}
	assertCharacter(t, requests[0].Sender.Character, 4, &hue)
	response = socialRequest(t, a, alice, "PATCH", "me/character", "application/json", []byte(`{"variant":0,"hue":null}`))
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &data) != nil {
		t.Fatalf("reset: %d %s", response.Code, response.Body)
	}
	assertCharacter(t, data.User.Character, 0, nil)
	if data.User.ProfileVersion != 2 {
		t.Fatalf("reset profile version: %d", data.User.ProfileVersion)
	}
	workos, err := s.UpsertUser("character-provider", "character-provider@example.test", "Initial", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetCharacter(workos.ID, CharacterAppearance{Variant: 5, Hue: &hue}); err != nil {
		t.Fatal(err)
	}
	workos, err = s.UpsertUser("character-provider", "character-provider@example.test", "Provider refresh", nil)
	if err != nil {
		t.Fatal(err)
	}
	assertCharacter(t, workos.Character, 5, &hue)
	if _, err = s.DeleteAccount(context.Background(), workos.ID); err != nil {
		t.Fatal(err)
	}
	var variant int
	var deletedHue *int
	if err = s.DB.QueryRow(context.Background(), `SELECT character_variant,character_hue FROM users WHERE id=$1`, workos.ID).Scan(&variant, &deletedHue); err != nil || variant != 0 || deletedHue != nil {
		t.Fatalf("deleted appearance retained: %d %v %v", variant, deletedHue, err)
	}
	if _, err = s.SetCharacter(workos.ID, CharacterAppearance{Variant: 1}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted account changed appearance: %v", err)
	}
}

func TestCharacterInputValidationIntegration(t *testing.T) {
	s := conversationTestStore(t)
	user := socialUsers(t, s, 1)[0]
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173"})
	for _, body := range []string{
		`{}`, `null`, `{"variant":1}`, `{"hue":42}`, `{"variant":null,"hue":null}`,
		`{"variant":-1,"hue":null}`, `{"variant":6,"hue":null}`, `{"variant":1.5,"hue":null}`,
		`{"variant":0,"hue":-1}`, `{"variant":0,"hue":360}`, `{"variant":0,"hue":4.5}`,
		`{"variant":"1","hue":null}`, `{"variant":0,"hue":"42"}`, `{"variant":0,"hue":true}`,
		`{"variant":1,"hue":null,"user_id":"someone-else"}`, `{"variant":1,"hue":null,"seed":"new"}`,
		`{"variant":1,"hue":null} {"variant":0,"hue":42}`,
	} {
		response := socialRequest(t, a, user, "PATCH", "me/character", "application/json", []byte(body))
		if response.Code != 400 {
			t.Fatalf("invalid appearance %s: %d %s", body, response.Code, response.Body)
		}
	}
	stored, err := s.UserByID(user.ID)
	if err != nil || stored.ProfileVersion != 0 {
		t.Fatalf("invalid input mutated profile: %+v %v", stored, err)
	}
	assertCharacter(t, stored.Character, 0, nil)
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, httptest.NewRequest("PATCH", "http://localhost:5173/api/v1/me/character", nil))
	if response.Code != 401 {
		t.Fatalf("unauthenticated character update: %d", response.Code)
	}
}

func TestCharacterGesturesAreAuthorizedTransientAndBoundedIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 3)
	owner, member, outsider := users[0], users[1], users[2]
	socialFriend(t, s, owner.ID, member.ID)
	community, err := s.CreateCommunity(owner.ID, "Gestures", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.AddCommunityMember(community.ID, owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	room := community.Channels[0]
	hue := 12
	member, err = s.SetCharacter(member.ID, CharacterAppearance{Variant: 2, Hue: &hue})
	if err != nil {
		t.Fatal(err)
	}
	root, err := s.WriteMessage(room.ID, owner.ID, "", "A thread", "")
	if err != nil {
		t.Fatal(err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173"})
	recipient := characterClient(a, owner, []Room{room}, nil)
	sender := characterClient(a, member, []Room{room}, nil)
	stranger := characterClient(a, outsider, nil, nil)
	body := []byte(fmt.Sprintf(`{"gesture":"wave","thread_root_id":%q}`, root.ID))
	response := socialRequest(t, a, member, "POST", "rooms/"+room.ID+"/character-gesture", "application/json", body)
	if response.Code != 204 || response.Body.Len() != 0 {
		t.Fatalf("gesture: %d %s", response.Code, response.Body)
	}
	for _, client := range []*realtimeClient{sender, recipient} {
		if len(client.send) != 1 {
			t.Fatalf("gesture fanout count: %d", len(client.send))
		}
		event := <-client.send
		var data struct {
			ID, RoomID, UserID, Name, Gesture, ThreadRootID string
			Character                                       CharacterAppearance `json:"character"`
		}
		var fields map[string]json.RawMessage
		if event.Type != "character.gesture" || event.From != member.ID || json.Unmarshal(event.Payload, &fields) != nil {
			t.Fatalf("gesture event: %+v", event)
		}
		json.Unmarshal(fields["id"], &data.ID)
		json.Unmarshal(fields["room_id"], &data.RoomID)
		json.Unmarshal(fields["user_id"], &data.UserID)
		json.Unmarshal(fields["thread_root_id"], &data.ThreadRootID)
		json.Unmarshal(fields["name"], &data.Name)
		json.Unmarshal(fields["gesture"], &data.Gesture)
		json.Unmarshal(fields["character"], &data.Character)
		if !uuidPattern.MatchString(data.ID) || data.RoomID != room.ID || data.UserID != member.ID || data.Name != member.Name || data.Gesture != "wave" || data.ThreadRootID != root.ID {
			t.Fatalf("untrusted gesture identity: %+v", data)
		}
		assertCharacter(t, data.Character, 2, &hue)
	}
	if len(stranger.send) != 0 {
		t.Fatal("gesture leaked outside room")
	}
	page, err := s.MessagePage(room.ID, member.ID, "", 10)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].ThreadReplyCount != 0 {
		t.Fatalf("gesture changed durable history: %+v %v", page, err)
	}
	reconnected := characterClient(a, member, []Room{room}, nil)
	if len(reconnected.send) != 0 {
		t.Fatal("gesture replayed after reconnect")
	}
	response = socialRequest(t, a, member, "POST", "rooms/"+room.ID+"/character-gesture", "application/json", body)
	if response.Code != 429 || response.Header().Get("Retry-After") == "" {
		t.Fatalf("gesture burst not bounded: %d %s", response.Code, response.Body)
	}
	// A second room/device shares the same account budget.
	response = socialRequest(t, a, member, "POST", "rooms/"+room.ID+"/character-gesture", "application/json", []byte(`{"gesture":"nod"}`))
	if response.Code != 429 {
		t.Fatalf("gesture device limit bypassed: %d", response.Code)
	}
	a.Realtime.publishRoom(room.ID, wire{Type: "character.gesture"})
	queued := <-recipient.send
	a.Realtime.unsubscribeUser(room.ID, owner.ID)
	if a.Realtime.canDeliver(recipient, queued) {
		t.Fatal("queued gesture survived room access revocation")
	}
	// Validate restrictions independently of the account's burst budget.
	request := func(user User, target, payload string, status int) {
		t.Helper()
		fresh := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173"})
		got := socialRequest(t, fresh, user, "POST", "rooms/"+target+"/character-gesture", "application/json", []byte(payload))
		if got.Code != status {
			t.Fatalf("gesture authorization %s: %d %s; want %d", payload, got.Code, got.Body, status)
		}
	}
	request(outsider, room.ID, `{"gesture":"wave"}`, 403)
	for _, invalid := range []string{`{"gesture":"dance"}`, `{"gesture":"wave","user_id":"spoof"}`, `{"gesture":"nod","character":{"variant":5}}`, `{"gesture":"wave","thread_root_id":"invalid"}`} {
		request(member, room.ID, invalid, 400)
	}
	request(member, room.ID, `{"gesture":"wave","thread_root_id":"00000000-0000-4000-8000-000000000001"}`, 404)
	private, err := s.CreateChannelWithPrivacy(community.ID, owner.ID, "private", "", "hybrid", true)
	if err != nil {
		t.Fatal(err)
	}
	request(member, private.ID, `{"gesture":"wave"}`, 403)
	privateRoot, err := s.WriteMessage(private.ID, owner.ID, "", "private thread", "")
	if err != nil {
		t.Fatal(err)
	}
	request(member, room.ID, fmt.Sprintf(`{"gesture":"wave","thread_root_id":%q}`, privateRoot.ID), 404)
	news, err := s.CreateChannel(community.ID, owner.ID, "announcements", "", "announcement")
	if err != nil {
		t.Fatal(err)
	}
	request(member, news.ID, `{"gesture":"wave"}`, 403)
	if err = s.SetChannelAccess(community.ID, room.ID, owner.ID, ChannelAccess{Overrides: []ChannelOverride{{SubjectKey: "member", Permissions: map[string]string{"post": "deny"}}}}); err != nil {
		t.Fatal(err)
	}
	request(member, room.ID, `{"gesture":"wave"}`, 403)
	if err = s.SetChannelAccess(community.ID, room.ID, owner.ID, ChannelAccess{}); err != nil {
		t.Fatal(err)
	}
	if err = s.ModerateMember(room.ID, owner.ID, member.ID, "timeout", "Pause", 60); err != nil {
		t.Fatal(err)
	}
	request(member, room.ID, `{"gesture":"wave"}`, 429)
	if _, err = s.DB.Exec(context.Background(), `UPDATE room_members SET posting_restricted_until=NULL WHERE user_id=$1`, member.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(context.Background(), `UPDATE community_members SET posting_restricted_until=NULL WHERE user_id=$1`, member.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.SetSlowMode(room.ID, owner.ID, 10); err != nil {
		t.Fatal(err)
	}
	request(member, room.ID, `{"gesture":"nod"}`, 429)
	if _, err = s.DB.Exec(context.Background(), `UPDATE room_members SET last_posted_at=clock_timestamp()-interval '11 seconds' WHERE room_id=$1 AND user_id=$2`, room.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	request(member, room.ID, `{"gesture":"celebrate"}`, 204)
	// Successful gestures consume slowmode, just like messages.
	request(member, room.ID, `{"gesture":"wave"}`, 429)
	direct, err := s.CreateDirectRoom(owner.ID, member.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.BlockUser(owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	request(member, direct.ID, `{"gesture":"wave"}`, 403)
}
