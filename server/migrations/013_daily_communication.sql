ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS voice_note boolean NOT NULL DEFAULT false;
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS duration_ms integer;
ALTER TABLE message_attachments DROP CONSTRAINT IF EXISTS voice_note_duration;
ALTER TABLE message_attachments ADD CONSTRAINT voice_note_duration CHECK
 ((voice_note AND duration_ms IS NOT NULL AND duration_ms BETWEEN 1 AND 120000) OR (NOT voice_note AND duration_ms IS NULL));

CREATE TABLE IF NOT EXISTS conversation_preferences (
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 favorite boolean NOT NULL DEFAULT false,
 archived boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(room_id,user_id)
);
CREATE INDEX IF NOT EXISTS conversation_preferences_account ON conversation_preferences(user_id);
CREATE TABLE IF NOT EXISTS user_custom_status (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 text text NOT NULL DEFAULT '' CHECK(char_length(text)<=100),
 emoji text NOT NULL DEFAULT '' CHECK(char_length(emoji)<=32),
 expires_at timestamptz,
 version bigint NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS custom_status_expiry ON user_custom_status(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS account_preferences (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 version bigint NOT NULL DEFAULT 1,
 settings jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(settings)='object')
);
CREATE INDEX IF NOT EXISTS mentions_activity_user ON message_mentions(user_id,message_id);
CREATE INDEX IF NOT EXISTS messages_reply_activity ON messages(reply_to_id,created_at DESC,id DESC) WHERE reply_to_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_author_activity ON messages(author_id,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS room_members_account_lookup ON room_members(user_id,room_id);
CREATE INDEX IF NOT EXISTS friend_requests_sender_activity ON friend_requests(sender_id,status,receiver_id);
CREATE INDEX IF NOT EXISTS friend_requests_receiver_activity ON friend_requests(receiver_id,status,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS dm_requests_receiver_activity ON dm_requests(receiver_id,status,created_at DESC,id DESC);
