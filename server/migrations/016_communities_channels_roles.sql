-- A legacy channel keeps its conversation UUID and all messages, media metadata,
-- reads and invitation tokens. Its new parent starts with the same UUID.
CREATE TABLE IF NOT EXISTS communities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
 description text NOT NULL DEFAULT '' CHECK (char_length(description)<=500),
 owner_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS community_members (
 community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','moderator','member')),
 joined_at timestamptz NOT NULL DEFAULT now(),
 posting_restricted_until timestamptz,
 PRIMARY KEY(community_id,user_id)
);
CREATE INDEX IF NOT EXISTS community_members_user ON community_members(user_id,community_id);
CREATE UNIQUE INDEX IF NOT EXISTS community_single_owner ON community_members(community_id) WHERE role='owner';
CREATE TABLE IF NOT EXISTS community_bans (
 community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(community_id,user_id)
);
CREATE TABLE IF NOT EXISTS community_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id),
 target_id uuid REFERENCES users(id),
 action text NOT NULL,
 detail text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_audit_recent ON community_audit(community_id,created_at DESC);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS community_id uuid REFERENCES communities(id) ON DELETE CASCADE;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS channel_type text NOT NULL DEFAULT 'hybrid' CHECK (channel_type IN ('hybrid','announcement'));
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS topic text NOT NULL DEFAULT '' CHECK (char_length(topic)<=500);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0 CHECK (position>=0);
ALTER TABLE room_members DROP CONSTRAINT IF EXISTS room_members_role_check;
ALTER TABLE room_members ADD CONSTRAINT room_members_role_check CHECK (role IN ('owner','admin','moderator','member'));
INSERT INTO communities(id,name,owner_id,created_at,updated_at)
 SELECT id,name,owner_id,created_at,created_at FROM rooms WHERE kind='channel' AND community_id IS NULL ON CONFLICT(id) DO NOTHING;
UPDATE rooms SET community_id=id WHERE kind='channel' AND community_id IS NULL;
INSERT INTO community_members(community_id,user_id,role,joined_at,posting_restricted_until)
 SELECT r.community_id,m.user_id,CASE WHEN m.user_id=r.owner_id THEN 'owner' ELSE 'member' END,m.joined_at,m.posting_restricted_until
 FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE r.kind='channel' ON CONFLICT(community_id,user_id) DO NOTHING;
INSERT INTO community_members(community_id,user_id,role,joined_at)
 SELECT id,owner_id,'owner',created_at FROM communities
 ON CONFLICT(community_id,user_id) DO UPDATE SET role='owner';
INSERT INTO room_members(room_id,user_id,role,joined_at,posting_restricted_until)
 SELECT r.id,m.user_id,m.role,m.joined_at,m.posting_restricted_until FROM rooms r JOIN community_members m ON m.community_id=r.community_id
 ON CONFLICT(room_id,user_id) DO UPDATE SET role=EXCLUDED.role,posting_restricted_until=EXCLUDED.posting_restricted_until;
INSERT INTO community_bans(community_id,user_id,actor_id,reason,created_at)
 SELECT r.community_id,b.user_id,b.actor_id,b.reason,b.created_at FROM room_bans b JOIN rooms r ON r.id=b.room_id WHERE r.kind='channel' ON CONFLICT(community_id,user_id) DO NOTHING;
INSERT INTO community_audit(id,community_id,actor_id,target_id,action,detail,created_at)
 SELECT a.id,r.community_id,a.actor_id,a.target_id,a.action,a.reason,a.created_at FROM room_moderation_audit a JOIN rooms r ON r.id=a.room_id WHERE r.kind='channel' ON CONFLICT(id) DO NOTHING;
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_community_kind;
ALTER TABLE rooms ADD CONSTRAINT rooms_community_kind CHECK ((kind='channel')=(community_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS rooms_community_order ON rooms(community_id,position,created_at,id) WHERE community_id IS NOT NULL;

-- Child membership mirrors the authoritative parent. Keep the existing message
-- membership rows so read cursors, notifications and media IDs keep their contracts.
CREATE OR REPLACE FUNCTION sync_community_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM room_members m USING rooms r WHERE m.room_id=r.id AND r.community_id=OLD.community_id AND m.user_id=OLD.user_id;
  RETURN OLD;
 END IF;
 INSERT INTO room_members(room_id,user_id,role,joined_at,posting_restricted_until)
  SELECT id,NEW.user_id,NEW.role,NEW.joined_at,NEW.posting_restricted_until FROM rooms WHERE community_id=NEW.community_id
  ON CONFLICT(room_id,user_id) DO UPDATE SET role=EXCLUDED.role,posting_restricted_until=EXCLUDED.posting_restricted_until;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS community_member_sync ON community_members;
CREATE TRIGGER community_member_sync AFTER INSERT OR UPDATE OR DELETE ON community_members FOR EACH ROW EXECUTE FUNCTION sync_community_member();
CREATE OR REPLACE FUNCTION sync_channel_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.community_id IS NOT NULL THEN
  INSERT INTO room_members(room_id,user_id,role,joined_at,posting_restricted_until)
   SELECT NEW.id,user_id,role,joined_at,posting_restricted_until FROM community_members WHERE community_id=NEW.community_id;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS channel_members_sync ON rooms;
CREATE TRIGGER channel_members_sync AFTER INSERT ON rooms FOR EACH ROW EXECUTE FUNCTION sync_channel_members();

-- Older API deployments and administrative importers still insert a standalone
-- channel and its roster. Bridge those writes during rollout instead of losing
-- parent authorization or breaking the old UUID-based conversation contract.
CREATE OR REPLACE FUNCTION create_legacy_channel_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='channel' AND NEW.community_id IS NULL THEN
  INSERT INTO communities(id,name,owner_id,created_at,updated_at) VALUES(NEW.id,NEW.name,NEW.owner_id,NEW.created_at,NEW.created_at);
  NEW.community_id=NEW.id;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS legacy_channel_parent ON rooms;
CREATE TRIGGER legacy_channel_parent BEFORE INSERT ON rooms FOR EACH ROW EXECUTE FUNCTION create_legacy_channel_parent();
CREATE OR REPLACE FUNCTION bridge_legacy_channel_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent uuid; owner uuid;
BEGIN
 IF pg_trigger_depth()>1 THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_OP='DELETE' THEN
  SELECT community_id INTO parent FROM rooms WHERE id=OLD.room_id;
  IF parent IS NOT NULL THEN DELETE FROM community_members WHERE community_id=parent AND user_id=OLD.user_id; END IF;
  RETURN OLD;
 END IF;
 SELECT r.community_id,c.owner_id INTO parent,owner FROM rooms r JOIN communities c ON c.id=r.community_id WHERE r.id=NEW.room_id;
 IF parent IS NOT NULL THEN
  INSERT INTO community_members(community_id,user_id,role,joined_at,posting_restricted_until)
   VALUES(parent,NEW.user_id,CASE WHEN NEW.user_id=owner THEN 'owner' ELSE 'member' END,NEW.joined_at,NEW.posting_restricted_until)
   ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS legacy_channel_member ON room_members;
CREATE TRIGGER legacy_channel_member AFTER INSERT OR DELETE ON room_members FOR EACH ROW EXECUTE FUNCTION bridge_legacy_channel_member();
CREATE OR REPLACE FUNCTION remove_empty_channel_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.community_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rooms WHERE community_id=OLD.community_id) THEN
  DELETE FROM communities WHERE id=OLD.community_id;
 END IF;
 RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS empty_channel_parent ON rooms;
CREATE TRIGGER empty_channel_parent AFTER DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION remove_empty_channel_parent();

CREATE OR REPLACE FUNCTION bridge_legacy_channel_ban() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  SELECT community_id INTO parent FROM rooms WHERE id=OLD.room_id;
  IF parent IS NOT NULL THEN DELETE FROM community_bans WHERE community_id=parent AND user_id=OLD.user_id; END IF;
  RETURN OLD;
 END IF;
 SELECT community_id INTO parent FROM rooms WHERE id=NEW.room_id;
 IF parent IS NOT NULL THEN
  INSERT INTO community_bans(community_id,user_id,actor_id,reason,created_at)
   VALUES(parent,NEW.user_id,NEW.actor_id,NEW.reason,NEW.created_at)
   ON CONFLICT(community_id,user_id) DO UPDATE SET actor_id=EXCLUDED.actor_id,reason=EXCLUDED.reason;
  DELETE FROM community_members WHERE community_id=parent AND user_id=NEW.user_id;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS legacy_channel_ban ON room_bans;
CREATE TRIGGER legacy_channel_ban AFTER INSERT OR UPDATE OR DELETE ON room_bans FOR EACH ROW EXECUTE FUNCTION bridge_legacy_channel_ban();

CREATE OR REPLACE FUNCTION can_access_room(target_room uuid, account_id uuid)
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
CREATE OR REPLACE FUNCTION room_has_permission(target_room uuid, account_id uuid, permission text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT can_access_room(r.id,account_id) AND CASE
  WHEN r.kind<>'channel' THEN CASE WHEN permission IN ('post','join_voice','pin_messages') THEN true ELSE r.kind='group' AND r.owner_id=account_id END
  WHEN permission='join_voice' THEN r.channel_type='hybrid'
  WHEN permission='post' THEN r.channel_type='hybrid' OR cm.role IN ('owner','admin')
  WHEN permission IN ('manage_community','manage_channels','manage_roles') THEN cm.role IN ('owner','admin')
  WHEN permission IN ('manage_members','moderate','manage_invites','pin_messages') THEN cm.role IN ('owner','admin','moderator')
  ELSE false END
 FROM rooms r LEFT JOIN community_members cm ON cm.community_id=r.community_id AND cm.user_id=account_id WHERE r.id=target_room),false);
$$;
