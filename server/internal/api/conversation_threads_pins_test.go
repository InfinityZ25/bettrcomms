package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func conversationTestStore(t *testing.T) *PostgresStore {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("threads_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close(); admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`); admin.Close() })
	files, err := filepath.Glob("../../migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		data, e := os.ReadFile(file)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, string(data)); e != nil {
			t.Fatalf("%s: %v", file, e)
		}
	}
	return &PostgresStore{DB: db}
}

func TestConversationThreadsPinsIntegration(t *testing.T) {
	s := conversationTestStore(t)
	ctx := context.Background()
	owner, err := s.UpsertDevUser("thread-owner@example.test", "Owner")
	if err != nil {
		t.Fatal(err)
	}
	member, err := s.UpsertDevUser("thread-member@example.test", "Member")
	if err != nil {
		t.Fatal(err)
	}
	outsider, err := s.UpsertDevUser("thread-outsider@example.test", "Outsider")
	if err != nil {
		t.Fatal(err)
	}
	room, err := s.CreateRoom(owner.ID, "Threads")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	root, err := s.WriteMessage(room.ID, owner.ID, "", "Original", " ")
	if err == nil {
		t.Fatal("invalid reply was accepted")
	}
	root, err = s.WriteMessage(room.ID, owner.ID, "", "Original", "")
	if err != nil {
		t.Fatal(err)
	}
	nonce := "11111111-1111-4111-8111-111111111111"
	first, published, err := s.SendThreadMessage(room.ID, owner.ID, "First reply", "", nonce, nil, root.ID)
	if err != nil || !published {
		t.Fatalf("thread send: %v", err)
	}
	retried, published, err := s.SendThreadMessage(room.ID, owner.ID, "First reply", "", nonce, nil, root.ID)
	if err != nil || published || retried.ID != first.ID {
		t.Fatalf("idempotency: %v", err)
	}
	if _, _, err = s.SendMessage(room.ID, owner.ID, "First reply", "", nonce, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("nonce crossed thread: %v", err)
	}
	second, _, err := s.SendThreadMessage(room.ID, owner.ID, "Second reply", first.ID, "", nil, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.SendThreadMessage(room.ID, owner.ID, "nested", "", "", nil, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("nested root: %v", err)
	}
	if _, err = s.WriteMessage(room.ID, owner.ID, "", "quote thread in main", first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross scope quote: %v", err)
	}
	main, err := s.MessagePage(room.ID, member.ID, "", 50)
	if err != nil || len(main.Messages) != 1 || main.Messages[0].ThreadReplyCount != 2 {
		t.Fatalf("main timeline: %+v %v", main, err)
	}
	after, err := s.MessagesAfter(room.ID, member.ID, root.Sequence, 50)
	if err != nil || len(after.Messages) != 0 {
		t.Fatalf("main catchup leaked replies: %+v %v", after, err)
	}
	page, err := s.ThreadPage(room.ID, member.ID, root.ID, "", nil, 1)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].ID != second.ID || page.BeforeID != second.ID || page.Root.ID != root.ID {
		t.Fatalf("thread page: %+v %v", page, err)
	}
	older, err := s.ThreadPage(room.ID, member.ID, root.ID, page.BeforeID, nil, 50)
	if err != nil || len(older.Messages) != 1 || older.Messages[0].ID != first.ID {
		t.Fatalf("older thread: %+v %v", older, err)
	}
	if err = s.ReadRoom(room.ID, member.ID, root.ID); err != nil {
		t.Fatal(err)
	}
	unread, err := s.UnreadRooms(member.ID)
	if err != nil || len(unread) != 1 || unread[0].Unread != 2 {
		t.Fatalf("main read acknowledged thread: %+v %v", unread, err)
	}
	if err = s.ReadRoom(room.ID, member.ID, second.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("main read accepted reply: %v", err)
	}
	if err = s.ReadThread(room.ID, member.ID, root.ID, second.ID); err != nil {
		t.Fatal(err)
	}
	unread, err = s.UnreadRooms(member.ID)
	if err != nil || unread[0].Unread != 0 {
		t.Fatalf("thread read: %+v %v", unread, err)
	}
	if _, err = s.ThreadPage(room.ID, outsider.ID, root.ID, "", nil, 50); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider read: %v", err)
	}
	if _, _, err = s.SendThreadMessage(room.ID, outsider.ID, "forbidden", "", "", nil, root.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("outsider send: %v", err)
	}
	if _, err = s.PinMessage(room.ID, member.ID, root.ID, false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member pin: %v", err)
	}
	pinned, err := s.PinMessage(room.ID, owner.ID, root.ID, false)
	if err != nil || pinned.PinnedAt == nil || *pinned.PinnedBy != owner.ID {
		t.Fatalf("pin metadata: %+v %v", pinned, err)
	}
	pins, err := s.ListPins(room.ID, member.ID)
	if err != nil || len(pins) != 1 || pins[0].ID != root.ID {
		t.Fatalf("pin listing: %+v %v", pins, err)
	}
	if _, err = s.DeleteMessage(room.ID, owner.ID, root.ID); err != nil {
		t.Fatal(err)
	}
	pins, err = s.ListPins(room.ID, member.ID)
	if err != nil || len(pins) != 0 {
		t.Fatalf("deleted pin persisted: %+v %v", pins, err)
	}
	if _, _, err = s.SendThreadMessage(room.ID, member.ID, "Continue existing thread", "", "", nil, root.ID); err != nil {
		t.Fatalf("tombstone thread lost: %v", err)
	}
	index, err := s.ListThreads(room.ID, owner.ID, "", 50)
	if err != nil || len(index.Messages) != 1 || index.Messages[0].ThreadUnreadCount != 1 {
		t.Fatalf("thread index: %+v %v", index, err)
	}
	fresh, err := s.UpsertDevUser("thread-fresh@example.test", "Fresh")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room.ID, fresh.ID); err != nil {
		t.Fatal(err)
	}
	unread, err = s.UnreadRooms(fresh.ID)
	if err != nil || unread[0].Unread != 0 {
		t.Fatalf("new member thread baseline: %+v %v", unread, err)
	}
}

func TestPinLimitIntegration(t *testing.T) {
	s := conversationTestStore(t)
	owner, err := s.UpsertDevUser("pins@example.test", "Pins")
	if err != nil {
		t.Fatal(err)
	}
	room, err := s.CreateRoom(owner.ID, "Pins")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 51; i++ {
		message, err := s.WriteMessage(room.ID, owner.ID, "", fmt.Sprint(i), "")
		if err != nil {
			t.Fatal(err)
		}
		_, err = s.PinMessage(room.ID, owner.ID, message.ID, false)
		if i < 50 && err != nil {
			t.Fatal(err)
		}
		if i == 50 && !errors.Is(err, ErrConflict) {
			t.Fatalf("pin cap: %v", err)
		}
	}
}
