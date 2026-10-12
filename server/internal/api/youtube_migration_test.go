package api

import (
	"context"
	"os"
	"testing"
)

func TestYouTubeMigrationRepeatsAndBackfillsExistingFileWatchIntegration(t *testing.T) {
	s, room, users := youtubeCommunity(t)
	ctx := context.Background()
	attachment, err := randomAttachmentID()
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SavePendingAttachment(room, users[0].ID, "migration-test/"+attachment, MessageAttachment{ID: attachment, Filename: "existing.mp4", ContentType: "video/mp4", SizeBytes: 100}); err != nil {
		t.Fatal(err)
	}
	if err = s.CompletePendingAttachment(attachment, room); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.SendMessage(room, users[0].ID, "Old watch", "", "", []string{attachment}); err != nil {
		t.Fatal(err)
	}
	// Restore only this isolated fixture's watch table to its pre-021 shape.
	if _, err = s.DB.Exec(ctx, `DELETE FROM bettercomms_feature_migrations WHERE name='021_youtube_watch'; ALTER TABLE channel_watch_sessions DROP CONSTRAINT watch_source; ALTER TABLE channel_watch_sessions DROP COLUMN source_kind,DROP COLUMN youtube_id,DROP COLUMN youtube_title,DROP COLUMN playback_id; ALTER TABLE channel_watch_sessions ALTER COLUMN attachment_id SET NOT NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `INSERT INTO channel_watch_sessions(room_id,attachment_id,host_id,paused,position_seconds,revision) VALUES($1,$2,$3,false,12,7)`, room, attachment, users[0].ID); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("../../migrations/021_youtube_watch.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, string(data)); err != nil {
		t.Fatalf("first upgrade: %v", err)
	}
	first, err := s.watchTogether(room, users[0].ID)
	if err != nil || first.SourceKind != "attachment" || first.PlaybackID == "" || first.Revision != 7 || first.PositionSeconds != 12 || first.Paused {
		t.Fatalf("file upgrade changed playback %+v %v", first, err)
	}
	for i := 0; i < 2; i++ {
		if _, err = s.DB.Exec(ctx, string(data)); err != nil {
			t.Fatalf("restart %d: %v", i, err)
		}
	}
	second, err := s.watchTogether(room, users[0].ID)
	if err != nil || second.PlaybackID != first.PlaybackID || second.Revision != first.Revision || second.Attachment.ID != attachment {
		t.Fatalf("restart reset watch %+v %v", second, err)
	}
	var markers int
	if err = s.DB.QueryRow(ctx, `SELECT count(*) FROM bettercomms_feature_migrations WHERE name='021_youtube_watch'`).Scan(&markers); err != nil || markers != 1 {
		t.Fatalf("migration marker %d %v", markers, err)
	}
}

func TestYouTubeMigrationFailedUpgradeLeavesNoMarkerIntegration(t *testing.T) {
	s := conversationTestStore(t)
	ctx := context.Background()
	if _, err := s.DB.Exec(ctx, `DELETE FROM bettercomms_feature_migrations WHERE name='021_youtube_watch'; ALTER TABLE channel_watch_sessions DROP CONSTRAINT watch_source; ALTER TABLE channel_watch_sessions DROP COLUMN source_kind,DROP COLUMN youtube_id,DROP COLUMN youtube_title,DROP COLUMN playback_id; ALTER TABLE channel_watch_sessions ALTER COLUMN attachment_id SET NOT NULL; DROP INDEX youtube_playlists_account; ALTER TABLE youtube_playlists RENAME COLUMN updated_at TO intentionally_invalid_column`); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("../../migrations/021_youtube_watch.sql")
	if err != nil {
		t.Fatal(err)
	}
	connection, err := s.DB.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Release()
	if _, err = connection.Exec(ctx, string(data)); err == nil {
		t.Fatal("broken schema unexpectedly migrated")
	}
	if _, err = connection.Exec(ctx, "ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	var marked, changed bool
	if err = connection.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bettercomms_feature_migrations WHERE name='021_youtube_watch'),EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='channel_watch_sessions' AND column_name='source_kind')`).Scan(&marked, &changed); err != nil {
		t.Fatal(err)
	}
	if marked || changed {
		t.Fatalf("failed migration persisted marker=%v column=%v", marked, changed)
	}
}
