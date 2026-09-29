CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked ON user_blocks(blocked_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_dm_requests boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS dm_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> receiver_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS dm_requests_pending_pair ON dm_requests(sender_id, receiver_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS dm_requests_receiver_pending ON dm_requests(receiver_id,created_at DESC) WHERE status='pending';
CREATE INDEX IF NOT EXISTS dm_requests_accepted_pair ON dm_requests(sender_id,receiver_id) WHERE status='accepted';

-- Every read path uses the same direct-room policy, including global search,
-- unread counts, and the initial realtime subscription list.
CREATE OR REPLACE FUNCTION can_access_room(target_room uuid, account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM rooms r JOIN room_members self ON self.room_id=r.id AND self.user_id=account_id
    WHERE r.id=target_room AND (
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
