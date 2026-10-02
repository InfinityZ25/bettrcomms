ALTER TABLE rooms ADD COLUMN IF NOT EXISTS slow_mode_seconds integer NOT NULL DEFAULT 0 CHECK (slow_mode_seconds BETWEEN 0 AND 3600);
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS posting_restricted_until timestamptz;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS last_posted_at timestamptz;
CREATE TABLE IF NOT EXISTS room_bans (
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(room_id,user_id)
);
CREATE TABLE IF NOT EXISTS room_moderation_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),
 target_id uuid REFERENCES users(id),
 action text NOT NULL CHECK (action IN ('ban','unban','timeout','clear_timeout','slow_mode','transfer_owner')),
 reason text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_moderation_audit_room ON room_moderation_audit(room_id,created_at DESC);
