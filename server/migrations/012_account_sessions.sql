ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_name text NOT NULL DEFAULT 'Unknown device';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id ON sessions(id);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id,created_at DESC);
CREATE OR REPLACE FUNCTION can_access_room(target_room uuid, account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM rooms r JOIN room_members self ON self.room_id=r.id AND self.user_id=account_id JOIN users account ON account.id=account_id AND account.deleted_at IS NULL
    WHERE r.id=target_room AND NOT EXISTS(SELECT 1 FROM room_bans banned WHERE banned.room_id=r.id AND banned.user_id=account_id) AND (
      r.kind<>'direct' OR EXISTS (
        SELECT 1 FROM room_members peer
        WHERE peer.room_id=r.id AND peer.user_id<>account_id
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
            (b.blocker_id=account_id AND b.blocked_id=peer.user_id) OR
            (b.blocker_id=peer.user_id AND b.blocked_id=account_id))
          AND (
            EXISTS (SELECT 1 FROM friend_requests f WHERE f.status='accepted' AND
              ((f.sender_id=account_id AND f.receiver_id=peer.user_id) OR
               (f.sender_id=peer.user_id AND f.receiver_id=account_id))) OR
            EXISTS (SELECT 1 FROM dm_requests d WHERE d.status='accepted' AND
              ((d.sender_id=account_id AND d.receiver_id=peer.user_id) OR
               (d.sender_id=peer.user_id AND d.receiver_id=account_id)))
          )
      )
    )
  );
$$;
