package api

import (
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestDailyPendingFriendRequestActionIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 3)
	alice, bob, outsider := users[0], users[1], users[2]
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost:5173", DevAuth: true})
	request, e := s.CreateFriendRequest(alice.ID, bob.ID)
	if e != nil {
		t.Fatal(e)
	}
	path := "friends/requests/" + request.ID + "/decline"
	dailyJSON(t, a, outsider, "POST", path, map[string]any{}, 404)
	dailyJSON(t, a, alice, "POST", "friends/requests/not-a-uuid/decline", map[string]any{}, 404)
	dailyJSON(t, a, alice, "POST", "friends/requests/"+request.ID+"/extra/decline", map[string]any{}, 404)
	// The new action keeps the existing authentication/origin boundary.
	unauth := httptest.NewRecorder()
	a.Handler().ServeHTTP(unauth, httptest.NewRequest("POST", "http://localhost:5173/api/v1/"+path, strings.NewReader("{}")))
	if unauth.Code != 401 {
		t.Fatalf("anonymous cancellation %d", unauth.Code)
	}
	issued := httptest.NewRecorder()
	seed := httptest.NewRequest("GET", "http://localhost:5173/", nil)
	if e = a.Sessions.Set(seed, issued, alice.ID); e != nil {
		t.Fatal(e)
	}
	attack := httptest.NewRequest("POST", "http://localhost:5173/api/v1/"+path, strings.NewReader("{}"))
	attack.Header.Set("Content-Type", "application/json")
	attack.Header.Set("Origin", "https://other.example")
	for _, cookie := range issued.Result().Cookies() {
		attack.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, attack)
	if response.Code != 403 {
		t.Fatalf("cross-origin cancellation %d", response.Code)
	}
	dailyJSON(t, a, bob, "POST", path, map[string]any{}, 200)
	dailyJSON(t, a, alice, "POST", path, map[string]any{}, 404)
	request, e = s.CreateFriendRequest(alice.ID, bob.ID)
	if e != nil {
		t.Fatal(e)
	}
	dailyJSON(t, a, alice, "POST", "friends/requests/"+request.ID+"/decline", map[string]any{}, 200)
	request, e = s.CreateFriendRequest(alice.ID, bob.ID)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.AcceptFriendRequest(request.ID, bob.ID); e != nil {
		t.Fatal(e)
	}
	dailyJSON(t, a, alice, "POST", "friends/requests/"+request.ID+"/decline", map[string]any{}, 404)
	dailyJSON(t, a, bob, "POST", "friends/requests/"+request.ID+"/decline", map[string]any{}, 404)
	friends, _, e := s.ListFriends(alice.ID)
	if e != nil || len(friends) != 1 || friends[0].ID != bob.ID {
		t.Fatalf("stale action removed accepted friendship: %+v %v", friends, e)
	}
	if !lifecycleMutation("POST", path) {
		t.Fatal("cancellation must hold the exclusive ACL lifecycle boundary")
	}
}

func TestDailyFriendRequestAcceptanceCancellationRaceIntegration(t *testing.T) {
	s := socialDatabase(t)
	users := socialUsers(t, s, 2)
	alice, bob := users[0], users[1]
	for i := 0; i < 6; i++ {
		request, e := s.CreateFriendRequest(alice.ID, bob.ID)
		if e != nil {
			t.Fatal(e)
		}
		start := make(chan struct{})
		var wait sync.WaitGroup
		wait.Add(2)
		var accepted, cancelled error
		go func() { defer wait.Done(); <-start; accepted = s.AcceptFriendRequest(request.ID, bob.ID) }()
		go func() { defer wait.Done(); <-start; _, cancelled = s.CancelPendingFriendRequest(request.ID, alice.ID) }()
		close(start)
		wait.Wait()
		if (accepted == nil) == (cancelled == nil) {
			t.Fatalf("race must have exactly one winner: accept %v cancel %v", accepted, cancelled)
		}
		if accepted != nil && !errors.Is(accepted, ErrNotFound) || cancelled != nil && !errors.Is(cancelled, ErrNotFound) {
			t.Fatalf("race failure: accept %v cancel %v", accepted, cancelled)
		}
		friends, pending, e := s.ListFriends(alice.ID)
		if e != nil || len(pending) != 0 {
			t.Fatalf("race state: %+v %+v %v", friends, pending, e)
		}
		if accepted == nil && (len(friends) != 1 || friends[0].ID != bob.ID) || cancelled == nil && len(friends) != 0 {
			t.Fatalf("winner not preserved: accept %v friends %+v", accepted, friends)
		}
		if _, e = s.DeleteFriendship(alice.ID, bob.ID); e != nil {
			t.Fatal(e)
		}
	}
}
