package api

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDMPrivacyIntegration(t *testing.T) {
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
	for _, file := range []string{"001_init.sql", "002_direct_rooms.sql", "003_messaging.sql", "004_messaging_complete.sql", "005_attachment_cleanup_attempts.sql", "006_attachment_lifecycle.sql", "007_dm_privacy.sql", "008_web_push.sql", "009_social_basics.sql", "010_conversation_threads_pins.sql", "011_moderation.sql", "012_account_sessions.sql", "013_daily_communication.sql", "014_activity_thread_replies.sql", "015_attachment_limits.sql", "016_communities_channels_roles.sql"} {
		data, readErr := os.ReadFile("../../migrations/" + file)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if _, err = db.Exec(ctx, string(data)); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
	}
	store := &PostgresStore{DB: db}
	suffix := fmt.Sprint(time.Now().UnixNano())
	alice, err := store.UpsertDevUser("privacy-a-"+suffix+"@example.test", "Alice")
	if err != nil {
		t.Fatal(err)
	}
	bob, err := store.UpsertDevUser("privacy-b-"+suffix+"@example.test", "Bob")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2`, alice.ID, bob.ID)
	// Defer runs last-in-first-out: remove the room before its owner.
	defer db.Exec(ctx, `DELETE FROM rooms WHERE direct_key=$1`, directPairKey(alice.ID, bob.ID))
	friendRequest, err := store.CreateFriendRequest(alice.ID, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.AcceptFriendRequest(friendRequest.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	friendRoom, err := store.CreateDirectRoom(alice.ID, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	revokedRoom, err := store.DeleteFriendship(alice.ID, bob.ID)
	if err != nil || revokedRoom != friendRoom.ID {
		t.Fatalf("unfriending did not identify the live room to revoke: %q %v", revokedRoom, err)
	}
	if _, err = store.RoomForMember(friendRoom.ID, alice.ID); err != ErrNotFound && err != ErrForbidden {
		t.Fatalf("unfriended direct room remains accessible: %v", err)
	}
	if _, err = store.CreateDMRequest(alice.ID, bob.ID, "Hello Bob"); err != ErrForbidden {
		t.Fatalf("default private policy allowed a request: %v", err)
	}
	if err = store.SetDMRequestsAllowed(bob.ID, true); err != nil {
		t.Fatal(err)
	}
	request, err := store.CreateDMRequest(alice.ID, bob.ID, "Hello Bob")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateDMRequest(alice.ID, bob.ID, "duplicate"); err != ErrForbidden {
		t.Fatalf("duplicate request was accepted: %v", err)
	}
	room, message, err := store.AcceptDMRequest(request.ID, bob.ID)
	if err != nil || message.Body != "Hello Bob" || message.Author.ID != alice.ID {
		t.Fatalf("accepted request lost its message: room=%+v message=%+v err=%v", room, message, err)
	}
	if _, err = store.RoomForMember(room.ID, alice.ID); err != nil {
		t.Fatalf("accepted DM is inaccessible: %v", err)
	}
	stillAllowed, err := store.DeleteFriendship(alice.ID, bob.ID)
	if err != nil || stillAllowed != "" {
		t.Fatalf("unfriending revoked a separately accepted DM: %q %v", stillAllowed, err)
	}
	var subscriptionID string
	if err = db.QueryRow(ctx, `INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,$2,'key','auth') RETURNING id::text`, bob.ID, "https://fcm.googleapis.com/"+suffix).Scan(&subscriptionID); err != nil {
		t.Fatal(err)
	}
	queued, publish, err := store.SendMessage(room.ID, alice.ID, "A queued message", "", "", nil)
	if err != nil || !publish {
		t.Fatalf("send with push subscription: %v", err)
	}
	var deliveries int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM push_deliveries WHERE message_id=$1 AND subscription_id=$2`, queued.ID, subscriptionID).Scan(&deliveries); err != nil || deliveries != 1 {
		t.Fatalf("push was not queued with message: %d %v", deliveries, err)
	}
	if _, err = db.Exec(ctx, `UPDATE push_subscriptions SET dnd=true WHERE id=$1`, subscriptionID); err != nil {
		t.Fatal(err)
	}
	quiet, _, err := store.SendMessage(room.ID, alice.ID, "Quiet message", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM push_deliveries WHERE message_id=$1`, quiet.ID).Scan(&deliveries); err != nil || deliveries != 0 {
		t.Fatalf("DND queued a push: %d %v", deliveries, err)
	}
	if _, err = db.Exec(ctx, `UPDATE push_subscriptions SET endpoint=$2,dnd=false WHERE id=$1`, subscriptionID, "https://127.0.0.1/"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err = store.DispatchPush(ctx, Config{VAPIDPublicKey: "test", VAPIDPrivateKey: "test", VAPIDSubject: "test"}); err != nil {
		t.Fatalf("push queue claim failed: %v", err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM push_deliveries WHERE message_id=$1`, queued.ID).Scan(&deliveries); err != nil || deliveries != 0 {
		t.Fatalf("invalid push endpoint was not removed: %d %v", deliveries, err)
	}
	if _, err = store.BlockUser(bob.ID, alice.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = store.SendMessage(room.ID, alice.ID, "Blocked send", "", "", nil); err != ErrForbidden {
		t.Fatalf("blocked sender wrote into the direct room: %v", err)
	}
	for _, person := range []User{alice, bob} {
		if _, err = store.RoomForMember(room.ID, person.ID); err == nil {
			t.Fatalf("blocked DM remains accessible to %s", person.Name)
		}
		rooms, listErr := store.ListRooms(person.ID)
		if listErr != nil {
			t.Fatal(listErr)
		}
		for _, visible := range rooms {
			if visible.ID == room.ID {
				t.Fatal("blocked DM remains in room list")
			}
		}
		page, searchErr := store.SearchMessages(person.ID, "", "", "Hello Bob", "", 50)
		if searchErr != nil || len(page.Messages) != 0 {
			t.Fatalf("blocked DM leaked through search: %+v %v", page, searchErr)
		}
	}
	if _, err = store.CreateFriendRequest(alice.ID, bob.ID); err == nil {
		t.Fatal("block did not prevent a friend request")
	}
	if err = store.UnblockUser(bob.ID, alice.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = store.RoomForMember(room.ID, alice.ID); err == nil {
		t.Fatal("unblock silently restored accepted DM access")
	}
}
