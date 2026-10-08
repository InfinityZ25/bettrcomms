ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS community_roles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
 color text NOT NULL DEFAULT '#64748b' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
 permissions jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(permissions)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(community_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS community_role_names ON community_roles(community_id,lower(name));
CREATE TABLE IF NOT EXISTS community_member_roles (
 community_id uuid NOT NULL,
 user_id uuid NOT NULL,
 role_id uuid NOT NULL,
 PRIMARY KEY(community_id,user_id,role_id),
 FOREIGN KEY(community_id,user_id) REFERENCES community_members(community_id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(community_id,role_id) REFERENCES community_roles(community_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS community_role_assignments ON community_member_roles(role_id,user_id);
CREATE TABLE IF NOT EXISTS channel_permission_overrides (
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 subject_key text NOT NULL CHECK (subject_key IN ('everyone','moderator','member') OR subject_key ~ '^[0-9a-f-]{36}$'),
 permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions)='object'),
 PRIMARY KEY(room_id,subject_key)
);

-- Membership and contact restrictions remain independent of channel visibility.
-- The following function preserves the pre-ACL access checks, including DM consent.
CREATE OR REPLACE FUNCTION room_membership_access(target_room uuid, account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM rooms r JOIN room_members self ON self.room_id=r.id AND self.user_id=account_id
  JOIN users account ON account.id=self.user_id AND account.deleted_at IS NULL
  WHERE r.id=target_room AND (
   (r.kind='channel'
    AND EXISTS(SELECT 1 FROM community_members cm WHERE cm.community_id=r.community_id AND cm.user_id=account_id)
    AND NOT EXISTS(SELECT 1 FROM community_bans b WHERE b.community_id=r.community_id AND b.user_id=account_id)) OR
   (r.kind='group' AND NOT EXISTS (
    SELECT 1 FROM room_members peer JOIN user_blocks b ON
     (b.blocker_id=account_id AND b.blocked_id=peer.user_id) OR (b.blocker_id=peer.user_id AND b.blocked_id=account_id)
    WHERE peer.room_id=r.id AND peer.user_id<>account_id
   )) OR
   (r.kind='direct' AND EXISTS (
    SELECT 1 FROM room_members peer WHERE peer.room_id=r.id AND peer.user_id<>account_id
    AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE
     (b.blocker_id=account_id AND b.blocked_id=peer.user_id) OR (b.blocker_id=peer.user_id AND b.blocked_id=account_id))
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
-- Deny wins across the member's applicable overrides. Administrators retain
-- access so a mistaken override cannot lock a community out of its settings.
CREATE OR REPLACE FUNCTION channel_has_permission(target_room uuid, account_id uuid, permission text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT room_membership_access(r.id,account_id) AND CASE
  WHEN permission NOT IN ('read','post','join_voice','pin_messages') THEN false
  WHEN permission='join_voice' AND r.channel_type='announcement' THEN false
  WHEN permission='post' AND r.channel_type='announcement' AND cm.role NOT IN ('owner','admin') THEN false
  WHEN cm.role IN ('owner','admin') THEN true
  WHEN EXISTS(SELECT 1 FROM channel_permission_overrides o WHERE o.room_id=r.id
   AND (o.subject_key='everyone' OR o.subject_key=cm.role OR EXISTS(SELECT 1 FROM community_member_roles mr WHERE mr.community_id=r.community_id AND mr.user_id=account_id AND mr.role_id::text=o.subject_key))
   AND o.permissions->>permission='deny') THEN false
  WHEN EXISTS(SELECT 1 FROM channel_permission_overrides o WHERE o.room_id=r.id
   AND (o.subject_key='everyone' OR o.subject_key=cm.role OR EXISTS(SELECT 1 FROM community_member_roles mr WHERE mr.community_id=r.community_id AND mr.user_id=account_id AND mr.role_id::text=o.subject_key))
   AND o.permissions->>permission='allow') THEN true
  WHEN EXISTS(SELECT 1 FROM community_member_roles mr JOIN community_roles cr ON cr.id=mr.role_id AND cr.community_id=mr.community_id
   WHERE mr.community_id=r.community_id AND mr.user_id=account_id AND cr.permissions->>permission='false') THEN false
  WHEN permission='read' THEN NOT r.is_private
  WHEN permission IN ('post','join_voice') THEN true
  WHEN permission='pin_messages' THEN cm.role='moderator' OR EXISTS(SELECT 1 FROM community_member_roles mr JOIN community_roles cr ON cr.id=mr.role_id AND cr.community_id=mr.community_id
   WHERE mr.community_id=r.community_id AND mr.user_id=account_id AND cr.permissions->>permission='true')
  ELSE false END FROM rooms r JOIN community_members cm ON cm.community_id=r.community_id AND cm.user_id=account_id
  WHERE r.id=target_room AND r.kind='channel'),false);
$$;
CREATE OR REPLACE FUNCTION can_access_room(target_room uuid, account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT CASE WHEN r.kind='channel' THEN channel_has_permission(r.id,account_id,'read')
  ELSE room_membership_access(r.id,account_id) END FROM rooms r WHERE r.id=target_room),false);
$$;
CREATE OR REPLACE FUNCTION room_has_permission(target_room uuid, account_id uuid, permission text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT can_access_room(r.id,account_id) AND CASE
  WHEN r.kind<>'channel' THEN CASE WHEN permission IN ('read','post','join_voice','pin_messages') THEN true ELSE r.kind='group' AND r.owner_id=account_id END
  WHEN permission IN ('read','post','join_voice','pin_messages') THEN channel_has_permission(r.id,account_id,permission)
  WHEN permission IN ('manage_community','manage_channels','manage_roles') THEN cm.role IN ('owner','admin')
  WHEN permission IN ('manage_members','moderate','manage_invites') THEN cm.role IN ('owner','admin','moderator')
  ELSE false END
 FROM rooms r LEFT JOIN community_members cm ON cm.community_id=r.community_id AND cm.user_id=account_id WHERE r.id=target_room),false);
$$;
