ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_version bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_edited boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_edited boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_version bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_status text NOT NULL DEFAULT 'online';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_check;
ALTER TABLE users ADD CONSTRAINT users_username_check CHECK (username IS NULL OR username ~ '^[a-z0-9_]{3,32}$');
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_bio_check;
ALTER TABLE users ADD CONSTRAINT users_bio_check CHECK (char_length(bio)<=160);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_presence_status_check;
ALTER TABLE users ADD CONSTRAINT users_presence_status_check CHECK (presence_status IN ('online','idle','dnd','invisible'));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username) WHERE username IS NOT NULL;
CREATE TABLE IF NOT EXISTS user_avatars (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  image bytea NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 262144)
);

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_kind_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_kind_check CHECK (kind IN ('channel','direct','group'));
CREATE TABLE IF NOT EXISTS room_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  max_uses integer NOT NULL DEFAULT 100 CHECK (max_uses BETWEEN 0 AND 1000),
  uses integer NOT NULL DEFAULT 0 CHECK (uses>=0),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS room_invites_room ON room_invites(room_id,created_at DESC);

-- A block prevents direct/group contact. Group membership is not contingent
-- on every friendship remaining accepted after the explicit invitation.
CREATE OR REPLACE FUNCTION can_access_room(target_room uuid, account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM rooms r JOIN room_members self ON self.room_id=r.id AND self.user_id=account_id
    WHERE r.id=target_room AND (
      r.kind='channel' OR
      (r.kind='group' AND NOT EXISTS (
        SELECT 1 FROM room_members peer JOIN user_blocks b ON
          (b.blocker_id=account_id AND b.blocked_id=peer.user_id) OR
          (b.blocker_id=peer.user_id AND b.blocked_id=account_id)
        WHERE peer.room_id=r.id AND peer.user_id<>account_id
      )) OR
      (r.kind='direct' AND EXISTS (
        SELECT 1 FROM room_members peer WHERE peer.room_id=r.id AND peer.user_id<>account_id
        AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE
          (b.blocker_id=account_id AND b.blocked_id=peer.user_id) OR
          (b.blocker_id=peer.user_id AND b.blocked_id=account_id))
        AND (
          EXISTS(SELECT 1 FROM friend_requests f WHERE f.status='accepted' AND
            ((f.sender_id=account_id AND f.receiver_id=peer.user_id) OR (f.sender_id=peer.user_id AND f.receiver_id=account_id))) OR
          EXISTS(SELECT 1 FROM dm_requests d WHERE d.status='accepted' AND
            ((d.sender_id=account_id AND d.receiver_id=peer.user_id) OR (d.sender_id=peer.user_id AND d.receiver_id=account_id)))
        )
      ))
    )
  );
$$;
