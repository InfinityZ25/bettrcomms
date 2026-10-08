package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMessagingIntegration(t *testing.T) {
	ctx := context.Background()
	store := conversationTestStore(t)
	db := store.DB
	suffix := fmt.Sprint(time.Now().UnixNano())
	alice, _ := store.UpsertDevUser("msg-a-"+suffix+"@example.test", "Alice")
	bob, _ := store.UpsertDevUser("msg-b-"+suffix+"@example.test", "Bob")
	outsider, _ := store.UpsertDevUser("msg-c-"+suffix+"@example.test", "Outsider")
	room, _ := store.CreateRoom(alice.ID, "Messaging")
	private, _ := store.CreateRoom(outsider.ID, "Private")
	defer db.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2 OR id=$3`, alice.ID, bob.ID, outsider.ID)
	defer db.Exec(ctx, `DELETE FROM rooms WHERE id=$1 OR id=$2`, room.ID, private.ID)
	if _, err := db.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	// The invitation trigger hashes PostgreSQL's canonical UUID text. A writer
	// using an uppercase spelling must wait on that same per-room lock.
	lockRoom, err := store.CreateRoom(alice.ID, "Lock probe")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Exec(ctx, `DELETE FROM rooms WHERE id=$1`, lockRoom.ID)
	lockTx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lockTx.Rollback(ctx)
	if _, err = lockTx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))`, lockRoom.ID); err != nil {
		t.Fatal(err)
	}
	writeDone := make(chan error, 1)
	go func() {
		_, writeErr := store.WriteMessage(strings.ToUpper(lockRoom.ID), alice.ID, "", "lock probe", "")
		writeDone <- writeErr
	}()
	// Observe the database waiting on the advisory lock. A start signal from
	// the goroutine would not prove that it had entered WriteMessage yet.
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(10 * time.Millisecond)
	defer poll.Stop()
	for {
		select {
		case writeErr := <-writeDone:
			t.Fatalf("uppercase room writer bypassed advisory lock: %v", writeErr)
		case <-deadline.C:
			t.Fatal("uppercase room writer never waited on the advisory lock")
		case <-poll.C:
			var waiting bool
			err = db.QueryRow(ctx, `SELECT EXISTS (
				SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
				WHERE l.locktype='advisory' AND NOT l.granted
				AND a.query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended(%'
			)`).Scan(&waiting)
			if err != nil {
				t.Fatal(err)
			}
			if waiting {
				goto writerWaited
			}
		}
	}
writerWaited:
	if err = lockTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case writeErr := <-writeDone:
		if writeErr != nil {
			t.Fatal(writeErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("uppercase room writer did not resume after releasing the lock")
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
	nonce, _ := randomAttachmentID()
	idempotentBody := `{"body":"sent once","client_nonce":"` + nonce + `"}`
	first := call(alice, "POST", "/rooms/"+room.ID+"/messages", idempotentBody, 201)
	second := call(alice, "POST", "/rooms/"+room.ID+"/messages", idempotentBody, 200)
	var sentFirst, sentSecond struct {
		Message Message `json:"message"`
	}
	if err = json.Unmarshal(first, &sentFirst); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(second, &sentSecond); err != nil {
		t.Fatal(err)
	}
	if sentFirst.Message.ID != sentSecond.Message.ID {
		t.Fatal("retry duplicated the message")
	}
	call(alice, "POST", "/rooms/"+room.ID+"/messages", `{"body":"different","client_nonce":"`+nonce+`"}`, 409)
	var count int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM messages WHERE client_nonce=$1`, nonce).Scan(&count); err != nil || count != 1 {
		t.Fatalf("idempotent count=%d err=%v", count, err)
	}
	page, err := store.MessagesAfter(room.ID, bob.ID, reply.Sequence, 2)
	if err != nil || len(page.Messages) != 2 || page.Messages[0].Sequence <= reply.Sequence || page.Messages[1].Sequence <= page.Messages[0].Sequence {
		t.Fatalf("after-sequence page: %+v %v", page, err)
	}
	call(bob, "PUT", "/messages/notification-preferences", `{"room_id":"`+room.ID+`","mode":"mentions"}`, 200)
	var preferences struct {
		Rooms map[string]string `json:"rooms"`
	}
	if err = json.Unmarshal(call(bob, "GET", "/messages/notification-preferences", "", 200), &preferences); err != nil || preferences.Rooms[room.ID] != "mentions" {
		t.Fatalf("notification preferences: %+v %v", preferences, err)
	}
	call(outsider, "PUT", "/messages/notification-preferences", `{"room_id":"`+room.ID+`","mode":"mute"}`, 403)
	storage := &fakeAttachmentStorage{}
	a.Attachments = storage
	var upload bytes.Buffer
	writer := multipart.NewWriter(&upload)
	part, err := writer.CreateFormFile("file", "note.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write([]byte("hello attachment")); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	issued := httptest.NewRecorder()
	if err = sessions.Set(httptest.NewRequest("GET", "/", nil), issued, alice.ID); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "http://localhost/api/v1/rooms/"+room.ID+"/attachments", &upload)
	request.Header.Set("Origin", "http://localhost")
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.AddCookie(issued.Result().Cookies()[0])
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)
	if response.Code != 201 {
		t.Fatalf("upload: %d %s", response.Code, response.Body.String())
	}
	var uploaded struct {
		Attachment MessageAttachment `json:"attachment"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	if storage.putCount != 1 || uploaded.Attachment.Filename != "note.txt" {
		t.Fatalf("upload result: %+v %+v", uploaded, storage)
	}
	attachmentMessage := call(alice, "POST", "/rooms/"+room.ID+"/messages", `{"body":"","attachment_ids":["`+uploaded.Attachment.ID+`"]}`, 201)
	var attached struct {
		Message Message `json:"message"`
	}
	if err = json.Unmarshal(attachmentMessage, &attached); err != nil || len(attached.Message.Attachments) != 1 {
		t.Fatalf("message attachment: %+v %v", attached, err)
	}
	call(bob, "GET", "/rooms/"+room.ID+"/attachments/"+uploaded.Attachment.ID+"?link=1", "", 200)
	call(outsider, "GET", "/rooms/"+room.ID+"/attachments/"+uploaded.Attachment.ID+"?link=1", "", 403)
	call(bob, "POST", "/rooms/"+room.ID+"/messages/"+attached.Message.ID+"/reports", `{"reason":"Please review this file"}`, 200)
	var reports struct {
		Reports []MessageReport `json:"reports"`
	}
	if err = json.Unmarshal(call(alice, "GET", "/rooms/"+room.ID+"/reports", "", 200), &reports); err != nil || len(reports.Reports) == 0 {
		t.Fatalf("reports: %+v %v", reports, err)
	}
	if reports.Reports[0].Excerpt != "[attachment]" {
		t.Fatalf("attachment report excerpt: %+v", reports.Reports[0])
	}
	call(bob, "GET", "/rooms/"+room.ID+"/reports", "", 403)
	call(bob, "POST", "/rooms/"+room.ID+"/reports/"+reports.Reports[0].ID+"/dismiss", "", 403)
	call(alice, "POST", "/rooms/"+room.ID+"/reports/"+reports.Reports[0].ID+"/dismiss", "", 200)
	if err = json.Unmarshal(call(alice, "GET", "/rooms/"+room.ID+"/reports", "", 200), &reports); err != nil || len(reports.Reports) != 0 {
		t.Fatalf("dismissed reports: %+v %v", reports, err)
	}
	call(bob, "POST", "/rooms/"+room.ID+"/messages/"+attached.Message.ID+"/reports", `{"reason":"Please review this file again"}`, 200)
	if err = json.Unmarshal(call(alice, "GET", "/rooms/"+room.ID+"/reports", "", 200), &reports); err != nil || len(reports.Reports) != 1 {
		t.Fatalf("reopened reports: %+v %v", reports, err)
	}
	call(bob, "DELETE", "/rooms/"+room.ID+"/messages/"+attached.Message.ID+"/moderation", `{"reason":"Reviewed report"}`, 403)
	call(alice, "DELETE", "/rooms/"+room.ID+"/messages/"+attached.Message.ID+"/moderation", `{"reason":"Reviewed report"}`, 200)
	if err = json.Unmarshal(call(alice, "GET", "/rooms/"+room.ID+"/reports", "", 200), &reports); err != nil || len(reports.Reports) != 0 {
		t.Fatalf("resolved reports: %+v %v", reports, err)
	}
	call(bob, "GET", "/rooms/"+room.ID+"/attachments/"+uploaded.Attachment.ID+"?link=1", "", 404)
	call(bob, "PUT", "/rooms/"+room.ID+"/read", `{"message_id":"`+foreign.ID+`"}`, 404)
	if _, err = db.Exec(ctx, `DELETE FROM room_members WHERE room_id=$1 AND user_id=$2`, room.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	call(bob, "GET", "/rooms/"+room.ID+"/messages/"+reply.ID, "", 403)
	restricted, _ := store.SearchMessages(bob.ID, "", "", "needle", "", 20)
	if len(restricted.Messages) != 0 {
		t.Fatal("revoked membership retained search access")
	}
	cleanupRoom, err := store.CreateRoom(alice.ID, "Attachment cleanup")
	if err != nil {
		t.Fatal(err)
	}
	cleanupID, err := randomAttachmentID()
	if err != nil {
		t.Fatal(err)
	}
	cleanupKey := "messages/" + cleanupID
	if err = store.SavePendingAttachment(cleanupRoom.ID, alice.ID, cleanupKey, MessageAttachment{ID: cleanupID, Filename: "cleanup.txt", ContentType: "text/plain", SizeBytes: 1}); err != nil {
		t.Fatal(err)
	}
	if err = store.CompletePendingAttachment(cleanupID, cleanupRoom.ID); err != nil {
		t.Fatal(err)
	}
	if err = store.DeleteRoom(cleanupRoom.ID, alice.ID); err != nil {
		t.Fatal(err)
	}
	var retained int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM message_attachments WHERE id=$1 AND room_id IS NULL`, cleanupID).Scan(&retained); err != nil || retained != 1 {
		t.Fatalf("room deletion lost attachment cleanup record: count=%d err=%v", retained, err)
	}
	if err = store.CleanPendingAttachments(ctx, storage); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM message_attachments WHERE id=$1`, cleanupID).Scan(&retained); err != nil || retained != 0 {
		t.Fatalf("attachment cleanup record remains: count=%d err=%v", retained, err)
	}
	if !slices.Contains(storage.deleted, cleanupKey) {
		t.Fatal("room deletion did not delete its S3 object")
	}
}

type fakeAttachmentStorage struct {
	putCount int
	deleted  []string
}

func (f *fakeAttachmentStorage) Put(_ context.Context, _ string, reader io.Reader, _ int64, _ string) error {
	_, err := io.Copy(io.Discard, reader)
	f.putCount++
	return err
}
func (f *fakeAttachmentStorage) URL(_ context.Context, _, _, _ string, _ bool) (string, error) {
	return "https://example.test/file", nil
}
func (f *fakeAttachmentStorage) Delete(_ context.Context, key string) error {
	f.deleted = append(f.deleted, key)
	return nil
}

func TestMessagingMigrationWithExistingHistory(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("messaging_migration_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	apply := func(file string) {
		t.Helper()
		data, e := os.ReadFile("../../migrations/" + file)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, string(data)); e != nil {
			t.Fatalf("%s: %v", file, e)
		}
	}
	apply("001_init.sql")
	apply("002_direct_rooms.sql")
	var alice, bob, carol, room string
	for i, target := range []*string{&alice, &bob, &carol} {
		err = db.QueryRow(ctx, `INSERT INTO users(email,name) VALUES($1,$2) RETURNING id::text`, fmt.Sprintf("old-%d@example.test", i), "Old member").Scan(target)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err = db.QueryRow(ctx, `INSERT INTO rooms(name,owner_id) VALUES('Old room',$1) RETURNING id::text`, alice).Scan(&room); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2),($1,$3)`, room, alice, bob); err != nil {
		t.Fatal(err)
	}
	oldIDs := make([]string, 3)
	for i := range oldIDs {
		err = db.QueryRow(ctx, `INSERT INTO messages(room_id,author_id,body,created_at) VALUES($1,$2,$3,$4) RETURNING id::text`, room, alice, fmt.Sprintf("old %d", i), time.Date(2026, 9, 1, 0, 0, i, 0, time.UTC)).Scan(&oldIDs[i])
		if err != nil {
			t.Fatal(err)
		}
	}
	apply("003_messaging.sql")
	apply("004_messaging_complete.sql")
	apply("005_attachment_cleanup_attempts.sql")
	apply("006_attachment_lifecycle.sql")
	apply("007_dm_privacy.sql")
	apply("008_web_push.sql")
	apply("009_social_basics.sql")
	apply("010_conversation_threads_pins.sql")
	apply("011_moderation.sql")
	apply("012_account_sessions.sql")
	apply("013_daily_communication.sql")
	apply("014_activity_thread_replies.sql")
	apply("015_attachment_limits.sql")
	apply("016_communities_channels_roles.sql")
	apply("017_storage_features.sql")
	apply("018_custom_permissions.sql")
	apply("019_channel_activities.sql")
	store := &PostgresStore{DB: db}
	seen := []string{}
	cursor := ""
	for {
		page, e := store.MessagePage(room, bob, cursor, 2)
		if e != nil {
			t.Fatal(e)
		}
		pageIDs := make([]string, 0, len(page.Messages))
		for _, m := range page.Messages {
			pageIDs = append(pageIDs, m.ID)
		}
		seen = append(pageIDs, seen...)
		if page.BeforeID == "" {
			break
		}
		cursor = page.BeforeID
	}
	if len(seen) != len(oldIDs) {
		t.Fatalf("migrated history: got %v, want %v", seen, oldIDs)
	}
	for i, id := range oldIDs {
		if seen[i] != id {
			t.Fatalf("migrated history: got %v, want %v", seen, oldIDs)
		}
	}
	checkUnread := func(user string, wantCount, wantSequence int64) {
		t.Helper()
		rooms, e := store.UnreadRooms(user)
		if e != nil || len(rooms) != 1 || rooms[0].Unread != wantCount || rooms[0].ReadSequence != wantSequence {
			t.Fatalf("unread for %s: %+v, err=%v; want count %d sequence %d", user, rooms, e, wantCount, wantSequence)
		}
	}
	var baseline int64
	if err = db.QueryRow(ctx, `SELECT sequence FROM messages WHERE id=$1`, oldIDs[2]).Scan(&baseline); err != nil {
		t.Fatal(err)
	}
	checkUnread(bob, 0, baseline)
	if _, err = db.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room, carol); err != nil {
		t.Fatal(err)
	}
	checkUnread(carol, 0, baseline)
	if _, err = store.WriteMessage(room, alice, "", "new after upgrade", ""); err != nil {
		t.Fatal(err)
	}
	checkUnread(bob, 1, baseline)
	checkUnread(carol, 1, baseline)
	if _, err = db.Exec(ctx, `INSERT INTO messages(room_id,author_id,body) VALUES($1,$2,'')`, room, alice); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"003_messaging.sql", "004_messaging_complete.sql", "005_attachment_cleanup_attempts.sql", "006_attachment_lifecycle.sql", "007_dm_privacy.sql", "008_web_push.sql", "009_social_basics.sql", "010_conversation_threads_pins.sql", "011_moderation.sql", "012_account_sessions.sql", "013_daily_communication.sql", "014_activity_thread_replies.sql", "015_attachment_limits.sql", "016_communities_channels_roles.sql"} {
		apply(file)
	}
}
