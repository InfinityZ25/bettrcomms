ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_root_id uuid REFERENCES messages(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_last_sequence bigint;
CREATE INDEX IF NOT EXISTS messages_thread_sequence ON messages(room_id,thread_root_id,sequence DESC);
CREATE INDEX IF NOT EXISTS messages_thread_root_sequence ON messages(thread_root_id,sequence DESC) WHERE thread_root_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_main_sequence ON messages(room_id,sequence DESC) WHERE thread_root_id IS NULL;
CREATE INDEX IF NOT EXISTS messages_active_threads ON messages(room_id,thread_last_sequence DESC) WHERE thread_last_sequence IS NOT NULL;
UPDATE messages root SET thread_last_sequence=latest.sequence
FROM (SELECT thread_root_id,max(sequence) sequence FROM messages WHERE thread_root_id IS NOT NULL GROUP BY thread_root_id) latest
WHERE root.id=latest.thread_root_id AND root.thread_last_sequence IS NULL;
CREATE TABLE IF NOT EXISTS thread_reads (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  root_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(root_id,user_id)
);
CREATE INDEX IF NOT EXISTS thread_reads_member_room ON thread_reads(user_id,room_id,root_id);
CREATE TABLE IF NOT EXISTS message_pins (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_pins_room ON message_pins(room_id,created_at DESC);
-- Room reads acknowledge the main timeline only. A new member begins at the
-- committed end of all existing threads, under the message-write room lock.
CREATE OR REPLACE FUNCTION baseline_thread_read() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.room_id::text,0));
  INSERT INTO thread_reads(room_id,root_id,user_id,sequence)
  SELECT NEW.room_id,m.thread_root_id,NEW.user_id,max(m.sequence)
  FROM messages m WHERE m.room_id=NEW.room_id AND m.thread_root_id IS NOT NULL
  GROUP BY m.thread_root_id ON CONFLICT(root_id,user_id) DO UPDATE SET sequence=EXCLUDED.sequence;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS room_member_thread_baseline ON room_members;
CREATE TRIGGER room_member_thread_baseline AFTER INSERT ON room_members
FOR EACH ROW EXECUTE FUNCTION baseline_thread_read();
