package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRealtimeWebSocketStartsWithScopedSnapshotAndPushesPresence(t *testing.T) {
	user := User{ID: "user-1", Email: "alice@example.test", Name: "Alice"}
	friend := User{ID: "user-2", Email: "bob@example.test", Name: "Bob"}
	room := Room{ID: "room-1", Name: "Shared"}
	store := presenceTestStore{
		testStore: testStore{user: user},
		rooms:     []Room{room},
		friends:   []User{friend},
	}
	sessions := newTestSessions(false)
	api := New(store, sessions, Config{DevAuth: true})
	server := httptest.NewServer(api.Handler())
	defer server.Close()

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	recorder := httptest.NewRecorder()
	if err := sessions.Set(request, recorder, user.ID); err != nil {
		t.Fatal(err)
	}
	header := http.Header{}
	header.Set("Cookie", recorder.Result().Cookies()[0].String())
	header.Set("Origin", server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/v1/events", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()

	var ready wire
	if err = wsjsonRead(ctx, conn, &ready); err != nil {
		t.Fatal(err)
	}
	if ready.Type != "app.ready" {
		t.Fatalf("first event = %#v", ready)
	}
	var snapshot struct {
		Presence      []RoomCallPresence `json:"presence"`
		OnlineUserIDs []string           `json:"online_user_ids"`
	}
	if err = json.Unmarshal(ready.Payload, &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Presence) != 1 || snapshot.Presence[0].RoomID != room.ID {
		t.Fatalf("unexpected scoped snapshot: %#v", snapshot)
	}

	callClient := &client{user: friend.ID, name: friend.Name, send: make(chan wire, 1)}
	api.Hub.add(room.ID, callClient)
	api.publishCallPresence(room.ID)
	var event wire
	if err = wsjsonRead(ctx, conn, &event); err != nil {
		t.Fatal(err)
	}
	if event.Type != "call.presence" {
		t.Fatalf("event = %#v", event)
	}
	var presence RoomCallPresence
	if err = json.Unmarshal(event.Payload, &presence); err != nil {
		t.Fatal(err)
	}
	if presence.RoomID != room.ID || len(presence.Participants) != 1 || presence.Participants[0].UserID != friend.ID {
		t.Fatalf("unexpected presence push: %#v", presence)
	}
}

func TestRealtimeHubScopesRoomEventsAndTracksContacts(t *testing.T) {
	hub := NewRealtimeHub()
	alice := &realtimeClient{user: "alice", send: make(chan wire, 4), rooms: map[string]struct{}{}, contacts: map[string]struct{}{}}
	bob := &realtimeClient{user: "bob", send: make(chan wire, 4), rooms: map[string]struct{}{}, contacts: map[string]struct{}{}}
	outsider := &realtimeClient{user: "outsider", send: make(chan wire, 4), rooms: map[string]struct{}{}, contacts: map[string]struct{}{}}
	hub.add(alice, []Room{{ID: "shared"}}, []User{{ID: "bob"}})
	hub.add(bob, []Room{{ID: "shared"}}, []User{{ID: "alice"}})
	hub.add(outsider, []Room{{ID: "private"}}, nil)

	hub.publishRoom("shared", wire{Type: "chat.message"})
	if (<-alice.send).Type != "chat.message" || (<-bob.send).Type != "chat.message" {
		t.Fatal("shared room subscribers did not receive chat event")
	}
	select {
	case event := <-outsider.send:
		t.Fatalf("private-room client received shared event: %#v", event)
	default:
	}

	hub.publishOnline("bob", true)
	event := <-alice.send
	if event.Type != "user.presence" || !strings.Contains(string(event.Payload), `"user_id":"bob"`) {
		t.Fatalf("friend presence event = %#v", event)
	}

	hub.unsubscribeUser("shared", "alice")
	hub.publishRoom("shared", wire{Type: "rooms.changed"})
	select {
	case event := <-alice.send:
		t.Fatalf("removed member still received room event: %#v", event)
	default:
	}
}
