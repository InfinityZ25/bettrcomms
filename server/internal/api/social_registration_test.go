package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Pause after reading ACLs but before socket registration, exactly where a
// completed removal used to miss the not-yet-registered client.
type registrationGateStore struct {
	testStore
	mu                                      sync.Mutex
	snapshotRead, continueSnapshot, removed chan struct{}
	room                                    Room
	hasMember                               bool
}

func (s *registrationGateStore) ListRooms(string) ([]Room, error) {
	s.mu.Lock()
	member := s.hasMember
	s.mu.Unlock()
	rooms := []Room{}
	if member {
		rooms = append(rooms, s.room)
	}
	close(s.snapshotRead)
	<-s.continueSnapshot
	return rooms, nil
}
func (s *registrationGateStore) ListFriends(string) ([]User, []FriendRequest, error) {
	return nil, nil, nil
}
func (s *registrationGateStore) RemoveRoomMember(string, string, string) error {
	s.mu.Lock()
	s.hasMember = false
	s.mu.Unlock()
	close(s.removed)
	return nil
}

func TestRealtimeRegistrationCannotRestoreRevokedMembership(t *testing.T) {
	user := User{ID: "10000000-0000-4000-8000-000000000002", Name: "Member"}
	owner := "10000000-0000-4000-8000-000000000001"
	room := "10000000-0000-4000-8000-000000000003"
	store := &registrationGateStore{testStore: testStore{user: user}, snapshotRead: make(chan struct{}), continueSnapshot: make(chan struct{}), removed: make(chan struct{}), room: Room{ID: room, OwnerID: owner, Kind: "group"}, hasMember: true}
	sessions := newTestSessions(false)
	a := New(store, sessions, Config{DevAuth: true})
	server := httptest.NewServer(a.Handler())
	defer server.Close()
	seed := httptest.NewRecorder()
	if err := sessions.Set(httptest.NewRequest("GET", "/", nil), seed, user.ID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type dialResult struct {
		conn *websocket.Conn
		err  error
	}
	dialed := make(chan dialResult, 1)
	go func() {
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/v1/events", &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {seed.Result().Cookies()[0].String()}, "Origin": {server.URL}}})
		dialed <- dialResult{conn, err}
	}()
	select {
	case <-store.snapshotRead:
	case <-ctx.Done():
		t.Fatal("snapshot did not pause")
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		request := httptest.NewRequest(http.MethodDelete, "/api/v1/rooms/"+room+"/members/"+user.ID, nil)
		request = request.WithContext(context.WithValue(request.Context(), userKey{}, User{ID: owner}))
		response := httptest.NewRecorder()
		a.authed(response, request)
		done <- response
	}()
	select {
	case <-store.removed:
		close(store.continueSnapshot)
		t.Fatal("removal committed between snapshot and registration")
	case <-time.After(100 * time.Millisecond):
	}
	close(store.continueSnapshot)
	result := <-dialed
	if result.err != nil {
		t.Fatal(result.err)
	}
	defer result.conn.CloseNow()
	var event wire
	if err := wsjsonRead(ctx, result.conn, &event); err != nil {
		t.Fatal(err)
	}
	if event.Type != "app.ready" {
		t.Fatal("missing initial snapshot")
	}
	response := <-done
	if response.Code != 200 {
		t.Fatal(response.Body)
	}
	a.Realtime.mu.RLock()
	defer a.Realtime.mu.RUnlock()
	for client := range a.Realtime.users[user.ID] {
		if _, subscribed := client.rooms[room]; subscribed {
			t.Fatal("removed member restored room subscription")
		}
	}
}

func TestProfilePublicEventOmitsDesiredPresenceAndKeepsVersion(t *testing.T) {
	h := NewRealtimeHub()
	owner := &realtimeClient{user: "owner", send: make(chan wire, 16)}
	friend := &realtimeClient{user: "friend", send: make(chan wire, 16)}
	room := Room{ID: "shared"}
	h.add(owner, []Room{room}, []User{{ID: "friend"}})
	h.add(friend, []Room{room}, []User{{ID: "owner"}})
	h.setPresence("owner", "invisible")
	<-owner.send
	<-friend.send
	h.publishProfile(User{ID: "owner", Name: "Changed", ProfileVersion: 4}, []Room{room})
	var payload struct{ User User }
	json.Unmarshal((<-friend.send).Payload, &payload)
	if payload.User.PresenceStatus != "" || payload.User.ProfileVersion != 4 {
		t.Fatalf("public profile %v", payload.User)
	}
	json.Unmarshal((<-owner.send).Payload, &payload)
	if payload.User.PresenceStatus != "invisible" {
		t.Fatalf("own desired presence omitted %v", payload.User)
	}
}
