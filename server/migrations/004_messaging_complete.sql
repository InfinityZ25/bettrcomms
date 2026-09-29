ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_nonce uuid;
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_nonce_unique
  ON messages(room_id,author_id,client_nonce) WHERE client_nonce IS NOT NULL;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check CHECK
  ((deleted_at IS NULL AND char_length(body) BETWEEN 0 AND 4000) OR (deleted_at IS NOT NULL AND body = ''));

CREATE TABLE IF NOT EXISTS message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  uploader_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 180),
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS message_attachments_pending
  ON message_attachments(created_at) WHERE message_id IS NULL;
CREATE INDEX IF NOT EXISTS message_attachments_message ON message_attachments(message_id);

CREATE TABLE IF NOT EXISTS message_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(message_id,reporter_id)
);
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
ALTER TABLE message_reports DROP CONSTRAINT IF EXISTS message_reports_status_check;
ALTER TABLE message_reports ADD CONSTRAINT message_reports_status_check CHECK (status IN ('open','dismissed','resolved'));
CREATE TABLE IF NOT EXISTS message_moderation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('remove','dismiss_report')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE message_moderation_audit DROP CONSTRAINT IF EXISTS message_moderation_audit_action_check;
ALTER TABLE message_moderation_audit ADD CONSTRAINT message_moderation_audit_action_check CHECK (action IN ('remove','dismiss_report'));

CREATE TABLE IF NOT EXISTS room_notification_preferences (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('all','mentions','mute')),
  PRIMARY KEY(room_id,user_id)
);
