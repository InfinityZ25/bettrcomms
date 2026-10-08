CREATE TABLE IF NOT EXISTS channel_polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  options jsonb NOT NULL CHECK (jsonb_array_length(options) BETWEEN 2 AND 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closes_at timestamptz,
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS channel_polls_room ON channel_polls(room_id,created_at DESC);
CREATE TABLE IF NOT EXISTS channel_poll_votes (
  poll_id uuid NOT NULL REFERENCES channel_polls(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_index integer NOT NULL CHECK (option_index BETWEEN 0 AND 9),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(poll_id,user_id)
);
CREATE TABLE IF NOT EXISTS channel_scheduled_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description)<=1000),
  starts_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at timestamptz
);
CREATE INDEX IF NOT EXISTS channel_scheduled_events_room ON channel_scheduled_events(room_id,starts_at,id);
CREATE TABLE IF NOT EXISTS channel_event_rsvps (
  event_id uuid NOT NULL REFERENCES channel_scheduled_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response text NOT NULL CHECK (response IN ('going','maybe','declined')),
  PRIMARY KEY(event_id,user_id)
);
CREATE TABLE IF NOT EXISTS channel_event_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES channel_scheduled_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  UNIQUE(event_id,user_id)
);
CREATE INDEX IF NOT EXISTS channel_event_reminders_inbox ON channel_event_reminders(user_id,created_at DESC) WHERE acknowledged_at IS NULL;
CREATE TABLE IF NOT EXISTS channel_watch_sessions (
  room_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
  host_id uuid REFERENCES users(id) ON DELETE SET NULL,
  paused boolean NOT NULL DEFAULT true,
  position_seconds double precision NOT NULL DEFAULT 0 CHECK (position_seconds BETWEEN 0 AND 604800),
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  host_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS channel_media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL UNIQUE REFERENCES message_attachments(id) ON DELETE CASCADE,
  creator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('sticker','sound')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  duration_ms integer CHECK (duration_ms BETWEEN 1 AND 30000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS channel_media_assets_room ON channel_media_assets(room_id,kind,created_at);
CREATE TABLE IF NOT EXISTS message_asset_links (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES channel_media_assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_edit_history (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version bigint NOT NULL,
  body text NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY(message_id,version)
);
CREATE OR REPLACE FUNCTION capture_message_edit_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Deletion and moderation erase retained content as well as the current body.
  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM message_edit_history WHERE message_id=NEW.id;
  ELSIF NEW.body IS DISTINCT FROM OLD.body AND NEW.edited_at IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM message_edit_history WHERE message_id=OLD.id) THEN
      INSERT INTO message_edit_history(message_id,version,body,changed_at)
        VALUES(OLD.id,OLD.version,OLD.body,COALESCE(OLD.edited_at,OLD.created_at));
    END IF;
    INSERT INTO message_edit_history(message_id,version,body,changed_at)
      VALUES(NEW.id,NEW.version,NEW.body,NEW.edited_at) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messages_capture_edit_history ON messages;
CREATE TRIGGER messages_capture_edit_history AFTER UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION capture_message_edit_history();
