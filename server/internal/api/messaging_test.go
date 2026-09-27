package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMessagingIntegration(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, file := range []string{"001_init.sql", "002_direct_rooms.sql", "003_messaging.sql"} {
		data, e := os.ReadFile("../../migrations/" + file)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, string(data)); e != nil {
			t.Fatal(e)
		}
	}
	store := &PostgresStore{DB: db}
	suffix := fmt.Sprint(time.Now().UnixNano())
	alice, _ := store.UpsertDevUser("msg-a-"+suffix+"@example.test", "Alice")
	bob, _ := store.UpsertDevUser("msg-b-"+suffix+"@example.test", "Bob")
	outsider, _ := store.UpsertDevUser("msg-c-"+suffix+"@example.test", "Outsider")
	room, _ := store.CreateRoom(alice.ID, "Messaging")
	private, _ := store.CreateRoom(outsider.ID, "Private")
	defer db.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2 OR id=$3`, alice.ID, bob.ID, outsider.ID)
	defer db.Exec(ctx, `DELETE FROM rooms WHERE id=$1 OR id=$2`, room.ID, private.ID)
	if _, err = db.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	sessions := Sessions{Store: store}
	a := New(store, sessions, Config{AppURL: "http://localhost"})
	call := func(user User, method, path, body string, want int) []byte {
		t.Helper()
		issued := httptest.NewRecorder()
		request := httptest.NewRequest("GET", "/", nil)
		if e := sessions.Set(request, issued, user.ID); e != nil {
			t.Fatal(e)
		}
		request = httptest.NewRequest(method, "http://localhost/api/v1"+path, strings.NewReader(body))
		request.Header.Set("Origin", "http://localhost")
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(issued.Result().Cookies()[0])
		response := httptest.NewRecorder()
		a.Handler().ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("%s %s: %d wanted %d: %s", method, path, response.Code, want, response.Body.String())
		}
		return response.Body.Bytes()
	}
	create := func(user User, rid, body, reply string) Message {
		t.Helper()
		payload, _ := json.Marshal(map[string]string{"body": body, "reply_to_id": reply})
		data := call(user, "POST", "/rooms/"+rid+"/messages", string(payload), 201)
		var v struct {
			Message Message `json:"message"`
		}
		if e := json.Unmarshal(data, &v); e != nil {
			t.Fatal(e)
		}
		return v.Message
	}
	root := create(alice, room.ID, "hello <@"+bob.ID+">", "")
	if len(root.Mentions) != 1 || root.Mentions[0].ID != bob.ID {
		t.Fatal("mention was not resolved")
	}
	foreign := create(outsider, private.ID, "secret needle", "")
	call(outsider, "GET", "/rooms/"+room.ID+"/messages", "", 403)
	call(bob, "POST", "/rooms/"+room.ID+"/messages", `{"body":"leak","reply_to_id":"`+foreign.ID+`"}`, 404)
	call(bob, "POST", "/rooms/"+room.ID+"/messages", `{"body":"<@`+outsider.ID+`>"}`, 403)
	call(bob, "PATCH", "/rooms/"+room.ID+"/messages/"+root.ID, `{"body":"stolen"}`, 403)
	call(bob, "DELETE", "/rooms/"+room.ID+"/messages/"+root.ID, "", 403)
	reply := create(bob, room.ID, "reply needle", root.ID)
	if reply.Reply == nil || reply.Reply.ID != root.ID {
		t.Fatal("missing reply")
	}
	for i := 0; i < 4; i++ {
		create(alice, room.ID, fmt.Sprintf("history %d needle", i), "")
	}
	// Equal timestamps must not cause page gaps; pagination follows the durable
	// sequence rather than rounding a timestamp in JavaScript.
	if _, err = db.Exec(ctx, `UPDATE messages SET created_at='2026-09-01T00:00:00Z' WHERE room_id=$1`, room.ID); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		data := call(bob, "GET", "/rooms/"+room.ID+"/messages?limit=2&before_id="+cursor, "", 200)
		var page MessagePage
		if e := json.Unmarshal(data, &page); e != nil {
			t.Fatal(e)
		}
		for _, m := range page.Messages {
			if seen[m.ID] {
				t.Fatal("duplicate page entry")
			}
			seen[m.ID] = true
		}
		if page.BeforeID == "" {
			break
		}
		cursor = page.BeforeID
	}
	if len(seen) != 6 {
		t.Fatalf("page gaps: %d", len(seen))
	}
	call(bob, "GET", "/rooms/"+room.ID+"/messages?before_id="+foreign.ID, "", 404)
	unread, e := store.UnreadRooms(bob.ID)
	if e != nil || len(unread) != 1 || unread[0].Unread != 5 || unread[0].Mentions != 1 {
		t.Fatalf("unread=%+v err=%v", unread, e)
	}
	payload := `{"emoji":"👍"}`
	for i := 0; i < 2; i++ {
		call(bob, "PUT", "/rooms/"+room.ID+"/messages/"+root.ID+"/reactions", payload, 200)
	}
	reacted, _ := store.MessageByID(room.ID, root.ID)
	if len(reacted.Reactions) != 1 || len(reacted.Reactions[0].Users) != 1 {
		t.Fatal("reaction not idempotent")
	}
	call(outsider, "PUT", "/rooms/"+room.ID+"/messages/"+root.ID+"/reactions", payload, 403)
	call(bob, "PUT", "/rooms/"+room.ID+"/messages/"+root.ID+"/reactions", `{"emoji":"invalid"}`, 400)
	call(bob, "DELETE", "/rooms/"+room.ID+"/messages/"+root.ID+"/reactions", payload, 200)
	call(alice, "PATCH", "/rooms/"+room.ID+"/messages/"+root.ID, `{"body":"edited needle"}`, 200)
	updated, _ := store.MessageByID(room.ID, reply.ID)
	if updated.Reply.Body != "edited needle" {
		t.Fatal("reply preview stale after edit")
	}
	data := call(bob, "GET", "/messages/search?q=needle&limit=2", "", 200)
	var found MessagePage
	json.Unmarshal(data, &found)
	if len(found.Messages) != 2 || found.BeforeID == "" {
		t.Fatal("search not paginated")
	}
	for _, m := range found.Messages {
		if m.RoomID != room.ID {
			t.Fatal("search leaked private conversation")
		}
	}
	call(bob, "GET", "/messages/search?q=needle&before_id="+foreign.ID, "", 404)
	own, e := store.SearchMessages(bob.ID, room.ID, alice.ID, "needle", "", 20)
	if e != nil || len(own.Messages) != 5 {
		t.Fatalf("search author filter: %+v %v", own, e)
	}
	call(alice, "DELETE", "/rooms/"+room.ID+"/messages/"+root.ID, "", 200)
	deleted, _ := store.MessageByID(room.ID, root.ID)
	if deleted.Body != "" || deleted.DeletedAt == nil || len(deleted.Mentions) != 0 || len(deleted.Reactions) != 0 {
		t.Fatal("delete retained content")
	}
	updated, _ = store.MessageByID(room.ID, reply.ID)
	if !updated.Reply.Deleted || updated.Reply.Body != "" {
		t.Fatal("deleted reply leaked content")
	}
	call(alice, "PATCH", "/rooms/"+room.ID+"/messages/"+root.ID, `{"body":"revive"}`, 404)
	call(bob, "PUT", "/rooms/"+room.ID+"/read", `{"message_id":"`+reply.ID+`"}`, 200)
	call(bob, "PUT", "/rooms/"+room.ID+"/read", `{"message_id":"`+root.ID+`"}`, 200)
	unread, _ = store.UnreadRooms(bob.ID)
	if unread[0].ReadSequence != reply.Sequence || unread[0].Unread != 4 {
		t.Fatal("read cursor moved backwards")
	}
	call(bob, "PUT", "/rooms/"+room.ID+"/read", `{"message_id":"`+foreign.ID+`"}`, 404)
	if _, err = db.Exec(ctx, `DELETE FROM room_members WHERE room_id=$1 AND user_id=$2`, room.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	call(bob, "GET", "/rooms/"+room.ID+"/messages/"+reply.ID, "", 403)
	restricted, _ := store.SearchMessages(bob.ID, "", "", "needle", "", 20)
	if len(restricted.Messages) != 0 {
		t.Fatal("revoked membership retained search access")
	}
}
