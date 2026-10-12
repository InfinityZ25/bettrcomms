BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':youtube-watch-migration021',6));
CREATE TABLE IF NOT EXISTS bettercomms_feature_migrations (
 name text PRIMARY KEY,
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $migration$
BEGIN
 IF EXISTS(SELECT 1 FROM bettercomms_feature_migrations WHERE name='021_youtube_watch') THEN
  RETURN;
 END IF;
ALTER TABLE channel_watch_sessions ALTER COLUMN attachment_id DROP NOT NULL;
ALTER TABLE channel_watch_sessions ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'attachment';
ALTER TABLE channel_watch_sessions ADD COLUMN IF NOT EXISTS youtube_id text;
ALTER TABLE channel_watch_sessions ADD COLUMN IF NOT EXISTS youtube_title text;
ALTER TABLE channel_watch_sessions ADD COLUMN IF NOT EXISTS playback_id uuid NOT NULL DEFAULT gen_random_uuid();
IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='channel_watch_sessions'::regclass AND conname='watch_source') THEN
 ALTER TABLE channel_watch_sessions ADD CONSTRAINT watch_source CHECK
  ((source_kind='attachment' AND attachment_id IS NOT NULL AND youtube_id IS NULL) OR
   (source_kind='youtube' AND attachment_id IS NULL AND youtube_id ~ '^[A-Za-z0-9_-]{11}$'));
END IF;

CREATE TABLE IF NOT EXISTS channel_watch_queue_state (
 room_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS channel_watch_queue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 author_id uuid REFERENCES users(id) ON DELETE SET NULL,
 youtube_id text NOT NULL CHECK(youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200),
 position integer NOT NULL,
 client_nonce uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(room_id,author_id,client_nonce)
);
CREATE INDEX IF NOT EXISTS channel_watch_queue_order ON channel_watch_queue(room_id,position,id);
CREATE TABLE IF NOT EXISTS channel_watch_queue_receipts (
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 client_nonce uuid NOT NULL,
 video jsonb NOT NULL,
 item_id uuid NOT NULL,
 PRIMARY KEY(room_id,user_id,client_nonce)
);
CREATE TABLE IF NOT EXISTS channel_watch_viewers (
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id uuid NOT NULL,
 seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(room_id,user_id,device_id)
);
CREATE INDEX IF NOT EXISTS channel_watch_viewers_expiry ON channel_watch_viewers(seen_at);
CREATE TABLE IF NOT EXISTS channel_watch_skip_votes (
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 playback_id uuid NOT NULL,
 PRIMARY KEY(room_id,user_id,playback_id)
);
CREATE TABLE IF NOT EXISTS youtube_playlists (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
 videos jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(videos)='array' AND jsonb_array_length(videos)<=100),
 version bigint NOT NULL DEFAULT 1,
 client_nonce uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,client_nonce)
);
CREATE INDEX IF NOT EXISTS youtube_playlists_account ON youtube_playlists(user_id,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS youtube_player_tickets (
 ticket_hash bytea PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 playback_id uuid NOT NULL,
 youtube_id text NOT NULL,
 parent_origin text NOT NULL,
 nonce text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '60 seconds'
);
CREATE INDEX IF NOT EXISTS youtube_player_ticket_expiry ON youtube_player_tickets(expires_at);
INSERT INTO bettercomms_feature_migrations(name) VALUES('021_youtube_watch');
END $migration$;
COMMIT;
