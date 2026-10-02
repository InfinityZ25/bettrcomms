package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEmojiReactionLimitsIntegration(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("emojis_%d", time.Now().UnixNano())
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
	files, _ := filepath.Glob("../../migrations/*.sql")
	for _, file := range files {
		data, e := os.ReadFile(file)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, string(data)); e != nil {
			t.Fatalf("%s: %v", file, e)
		}
	}
	s := &PostgresStore{DB: db}
	alice, err := s.UpsertDevUser("emoji-alice@example.test", "Alice")
	if err != nil {
		t.Fatal(err)
	}
	bob, err := s.UpsertDevUser("emoji-bob@example.test", "Bob")
	if err != nil {
		t.Fatal(err)
	}
	charlie, err := s.UpsertDevUser("emoji-charlie@example.test", "Charlie")
	if err != nil {
		t.Fatal(err)
	}
	room, err := s.CreateRoom(alice.ID, "Emoji limits")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room.ID, charlie.ID); err != nil {
		t.Fatal(err)
	}
	message, err := s.WriteMessage(room.ID, alice.ID, "", "React here", "")
	if err != nil {
		t.Fatal(err)
	}
	choices := strings.Fields(emojiSequences)
	for i := 0; i < 20; i++ {
		user := alice.ID
		if i >= 10 {
			user = bob.ID
		}
		if _, err = s.ReactMessage(room.ID, user, message.ID, choices[i], false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.ReactMessage(room.ID, alice.ID, message.ID, choices[0], false); err != nil {
		t.Fatalf("idempotent existing reaction: %v", err)
	}
	if _, err = s.ReactMessage(room.ID, alice.ID, message.ID, choices[20], false); !errors.Is(err, ErrReactionLimit) {
		t.Fatalf("eleventh reaction: %v", err)
	}
	if _, err = s.ReactMessage(room.ID, charlie.ID, message.ID, choices[20], false); !errors.Is(err, ErrReactionLimit) {
		t.Fatalf("twenty-first distinct reaction: %v", err)
	}
	if _, err = s.ReactMessage(room.ID, charlie.ID, message.ID, choices[1], false); err != nil {
		t.Fatalf("existing emoji at message capacity: %v", err)
	}
	if _, err = s.ReactMessage(room.ID, alice.ID, message.ID, choices[0], true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReactMessage(room.ID, alice.ID, message.ID, choices[20], false); err != nil {
		t.Fatalf("removal did not free capacity: %v", err)
	}
	// Race thirteen additions by one member: the message lock keeps exactly ten.
	race, err := s.WriteMessage(room.ID, alice.ID, "", "Concurrent reactions", "")
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 13)
	for _, emoji := range choices[:13] {
		go func(emoji string) { _, e := s.ReactMessage(room.ID, alice.ID, race.ID, emoji, false); results <- e }(emoji)
	}
	accepted := 0
	for range 13 {
		e := <-results
		if e == nil {
			accepted++
		} else if !errors.Is(e, ErrReactionLimit) {
			t.Fatal(e)
		}
	}
	if accepted != 10 {
		t.Fatalf("concurrent cap: accepted %d", accepted)
	}
}
