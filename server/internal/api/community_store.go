package api

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrLastChannel = errors.New("a community needs at least one channel")

type Community struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	OwnerID     string    `json:"owner_id"`
	Role        string    `json:"role"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Channels    []Room    `json:"channels"`
}

type ChannelUpdate struct {
	Name        *string `json:"name"`
	Topic       *string `json:"topic"`
	ChannelType *string `json:"channel_type"`
	Position    *int    `json:"position"`
	IsPrivate   *bool   `json:"is_private"`
}

func communityRank(role string) int {
	switch role {
	case "owner":
		return 4
	case "admin":
		return 3
	case "moderator":
		return 2
	case "member":
		return 1
	default:
		return 0
	}
}

func permissionsForRoom(r Room) RoomPermissions {
	if r.Kind != "channel" {
		manage := r.Kind == "group" && r.Role == "owner"
		return RoomPermissions{Read: true, ManageMembers: manage, Moderate: manage, PinMessages: true, Post: true, JoinVoice: true}
	}
	admin := communityRank(r.Role) >= 3
	moderator := communityRank(r.Role) >= 2
	return RoomPermissions{Read: true, ManageCommunity: admin, ManageChannels: admin, ManageMembers: moderator, ManageRoles: admin,
		Moderate: moderator, ManageInvites: moderator, PinMessages: moderator,
		Post: r.ChannelType != "announcement" || admin, JoinVoice: r.ChannelType != "announcement"}
}

const roomSelect = `SELECT r.id::text,r.name,r.owner_id::text,COALESCE(cm.role,rm.role),r.kind,r.created_at,r.slow_mode_seconds,
 CASE WHEN r.kind='direct' THEN (SELECT u.name FROM room_members other JOIN users u ON u.id=other.user_id WHERE other.room_id=r.id AND other.user_id<>$1 ORDER BY other.joined_at LIMIT 1) END,
 COALESCE((SELECT m.created_at FROM messages m WHERE m.room_id=r.id ORDER BY m.sequence DESC LIMIT 1),r.created_at),
 r.community_id::text,c.name,r.channel_type,r.topic,r.position,r.is_private,
 room_has_permission(r.id,$1,'read'),room_has_permission(r.id,$1,'manage_community'),room_has_permission(r.id,$1,'manage_channels'),room_has_permission(r.id,$1,'manage_members'),room_has_permission(r.id,$1,'manage_roles'),
 room_has_permission(r.id,$1,'moderate'),room_has_permission(r.id,$1,'manage_invites'),room_has_permission(r.id,$1,'pin_messages'),room_has_permission(r.id,$1,'post'),room_has_permission(r.id,$1,'join_voice')
 FROM rooms r JOIN room_members rm ON rm.room_id=r.id
 LEFT JOIN communities c ON c.id=r.community_id LEFT JOIN community_members cm ON cm.community_id=c.id AND cm.user_id=rm.user_id`

func scanRoom(row pgx.Row) (Room, error) {
	var r Room
	err := row.Scan(&r.ID, &r.Name, &r.OwnerID, &r.Role, &r.Kind, &r.CreatedAt, &r.SlowModeSeconds,
		&r.DisplayName, &r.ActivityAt, &r.CommunityID, &r.CommunityName, &r.ChannelType, &r.Topic, &r.Position, &r.IsPrivate,
		&r.Permissions.Read, &r.Permissions.ManageCommunity, &r.Permissions.ManageChannels, &r.Permissions.ManageMembers, &r.Permissions.ManageRoles,
		&r.Permissions.Moderate, &r.Permissions.ManageInvites, &r.Permissions.PinMessages, &r.Permissions.Post, &r.Permissions.JoinVoice)
	return r, norm(err)
}

func (s *PostgresStore) ListCommunities(user string) ([]Community, error) {
	ctx := context.Background()
	rows, err := s.DB.Query(ctx, `SELECT c.id::text,c.name,c.description,c.owner_id::text,m.role,c.created_at,c.updated_at
 FROM communities c JOIN community_members m ON m.community_id=c.id JOIN users u ON u.id=m.user_id
 WHERE m.user_id=$1 AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM community_bans b WHERE b.community_id=c.id AND b.user_id=$1) ORDER BY c.created_at,c.id`, user)
	if err != nil {
		return nil, err
	}
	out := []Community{}
	for rows.Next() {
		var c Community
		if err = rows.Scan(&c.ID, &c.Name, &c.Description, &c.OwnerID, &c.Role, &c.CreatedAt, &c.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		c.Channels = []Room{}
		out = append(out, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	rooms, err := s.ListRooms(user)
	if err != nil {
		return nil, err
	}
	index := map[string]int{}
	for i := range out {
		index[out[i].ID] = i
	}
	for _, room := range rooms {
		if room.CommunityID != nil {
			if i, found := index[*room.CommunityID]; found {
				out[i].Channels = append(out[i].Channels, room)
			}
		}
	}
	return out, nil
}

func (s *PostgresStore) CommunityForMember(id, user string) (Community, error) {
	items, err := s.ListCommunities(user)
	if err != nil {
		return Community{}, err
	}
	for _, c := range items {
		if c.ID == id {
			return c, nil
		}
	}
	return Community{}, ErrForbidden
}

func (s *PostgresStore) CreateCommunity(user, name, description, channelName string) (Community, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Community{}, err
	}
	defer tx.Rollback(ctx)
	var id string
	if err = tx.QueryRow(ctx, `INSERT INTO communities(name,description,owner_id) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM users WHERE id=$3 AND deleted_at IS NULL) RETURNING id::text`, name, description, user).Scan(&id); err != nil {
		return Community{}, norm(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO community_members(community_id,user_id,role) VALUES($1,$2,'owner')`, id, user); err != nil {
		return Community{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO rooms(id,name,owner_id,kind,community_id) VALUES($1,$2,$3,'channel',$1)`, id, channelName, user); err != nil {
		return Community{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Community{}, err
	}
	return s.CommunityForMember(id, user)
}

// Administrative transactions lock the parent before its roster and channels.
// API accessMu also serializes role changes with socket admission and media leases.
func lockCommunity(ctx context.Context, tx pgx.Tx, id, actor string, minimum int) (string, error) {
	var owner string
	if err := tx.QueryRow(ctx, `SELECT owner_id::text FROM communities WHERE id=$1 FOR UPDATE`, id).Scan(&owner); err != nil {
		return "", norm(err)
	}
	var role string
	if err := tx.QueryRow(ctx, `SELECT role FROM community_members m JOIN users u ON u.id=m.user_id WHERE m.community_id=$1 AND m.user_id=$2 AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM community_bans WHERE community_id=$1 AND user_id=$2) FOR UPDATE OF m`, id, actor).Scan(&role); err != nil {
		return "", ErrForbidden
	}
	if communityRank(role) < minimum {
		return "", ErrForbidden
	}
	return owner, nil
}

func auditCommunity(ctx context.Context, tx pgx.Tx, id, actor, target, action, detail string) error {
	_, err := tx.Exec(ctx, `INSERT INTO community_audit(community_id,actor_id,target_id,action,detail) VALUES($1,$2,NULLIF($3,'')::uuid,$4,$5)`, id, actor, target, action, detail)
	return err
}

func (s *PostgresStore) UpdateCommunity(id, actor string, name, description *string) (Community, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Community{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 3); err != nil {
		return Community{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE communities SET name=COALESCE($2,name),description=COALESCE($3,description),updated_at=clock_timestamp() WHERE id=$1`, id, name, description); err != nil {
		return Community{}, err
	}
	if err = auditCommunity(ctx, tx, id, actor, "", "update_community", ""); err != nil {
		return Community{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Community{}, err
	}
	return s.CommunityForMember(id, actor)
}

func (s *PostgresStore) DeleteCommunity(id, actor string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 4); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM communities WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) CreateChannel(id, actor, name, topic, channelType string) (Room, error) {
	return s.CreateChannelWithPrivacy(id, actor, name, topic, channelType, false)
}

func (s *PostgresStore) CreateChannelWithPrivacy(id, actor, name, topic, channelType string, private bool) (Room, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Room{}, err
	}
	defer tx.Rollback(ctx)
	owner, err := lockCommunity(ctx, tx, id, actor, 3)
	if err != nil {
		return Room{}, err
	}
	var room string
	if err = tx.QueryRow(ctx, `INSERT INTO rooms(name,owner_id,kind,community_id,channel_type,topic,position,is_private) SELECT $2,$3,'channel',$1,$4,$5,COALESCE(max(position)+1,0),$6 FROM rooms WHERE community_id=$1 RETURNING id::text`, id, name, owner, channelType, topic, private).Scan(&room); err != nil {
		return Room{}, err
	}
	if err = auditCommunity(ctx, tx, id, actor, "", "create_channel", room); err != nil {
		return Room{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Room{}, err
	}
	return s.RoomForMember(room, actor)
}

func (s *PostgresStore) UpdateChannel(id, room, actor string, in ChannelUpdate) (Room, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Room{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 3); err != nil {
		return Room{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE rooms SET name=COALESCE($3,name),topic=COALESCE($4,topic),channel_type=COALESCE($5,channel_type),position=COALESCE($6,position),is_private=COALESCE($7,is_private) WHERE id=$2 AND community_id=$1`, id, room, in.Name, in.Topic, in.ChannelType, in.Position, in.IsPrivate)
	if err != nil {
		return Room{}, err
	}
	if tag.RowsAffected() == 0 {
		return Room{}, ErrNotFound
	}
	if in.ChannelType != nil && *in.ChannelType == "announcement" {
		// Returning to hybrid starts a fresh activity rather than reviving an
		// obsolete playback anchor from before voice admission was disabled.
		if _, err = tx.Exec(ctx, `DELETE FROM channel_watch_sessions WHERE room_id=$1`, room); err != nil {
			return Room{}, err
		}
	}
	if err = auditCommunity(ctx, tx, id, actor, "", "update_channel", room); err != nil {
		return Room{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Room{}, err
	}
	return s.RoomForMember(room, actor)
}

func (s *PostgresStore) DeleteChannel(id, room, actor string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 3); err != nil {
		return err
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM rooms WHERE community_id=$1`, id).Scan(&count); err != nil {
		return err
	}
	if count <= 1 {
		return ErrLastChannel
	}
	// Preserve links created for this channel by moving their conversation target
	// to the first surviving sibling; redemption still joins the same community.
	if _, err = tx.Exec(ctx, `UPDATE room_invites SET room_id=(SELECT id FROM rooms WHERE community_id=$1 AND id<>$2 ORDER BY position,created_at,id LIMIT 1) WHERE room_id=$2`, id, room); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM rooms WHERE id=$2 AND community_id=$1`, id, room)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err = auditCommunity(ctx, tx, id, actor, "", "delete_channel", room); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) ReorderChannels(id, actor string, ids []string) (Community, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Community{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 3); err != nil {
		return Community{}, err
	}
	var valid bool
	if err = tx.QueryRow(ctx, `SELECT count(*)=cardinality($2::uuid[]) AND count(*)=(SELECT count(DISTINCT value) FROM unnest($2::uuid[]) value) AND bool_and(id=ANY($2::uuid[])) FROM rooms WHERE community_id=$1`, id, ids).Scan(&valid); err != nil {
		return Community{}, err
	}
	if !valid {
		return Community{}, ErrForbidden
	}
	if _, err = tx.Exec(ctx, `UPDATE rooms r SET position=ordered.ordinality-1 FROM unnest($2::uuid[]) WITH ORDINALITY ordered(id,ordinality) WHERE r.community_id=$1 AND r.id=ordered.id`, id, ids); err != nil {
		return Community{}, err
	}
	if err = auditCommunity(ctx, tx, id, actor, "", "reorder_channels", ""); err != nil {
		return Community{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Community{}, err
	}
	return s.CommunityForMember(id, actor)
}

func (s *PostgresStore) CommunityMembers(id, user string) ([]RoomMember, error) {
	if _, err := s.CommunityForMember(id, user); err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(context.Background(), `SELECT u.id::text,u.email,u.name,u.avatar_url,u.created_at,u.username,u.bio,u.profile_version,m.role,m.joined_at,m.posting_restricted_until,ARRAY(SELECT mr.role_id::text FROM community_member_roles mr WHERE mr.community_id=m.community_id AND mr.user_id=m.user_id ORDER BY mr.role_id)
 FROM community_members m JOIN users u ON u.id=m.user_id WHERE m.community_id=$1 AND u.deleted_at IS NULL ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END,u.name,u.id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RoomMember{}
	for rows.Next() {
		var m RoomMember
		if err = rows.Scan(&m.User.ID, &m.User.Email, &m.User.Name, &m.User.AvatarURL, &m.User.CreatedAt, &m.User.Username, &m.User.Bio, &m.User.ProfileVersion, &m.Role, &m.JoinedAt, &m.RestrictedUntil, &m.CustomRoleIDs); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func communityTarget(ctx context.Context, tx pgx.Tx, id, actor, target string) (string, error) {
	var actorRole, targetRole string
	if err := tx.QueryRow(ctx, `SELECT a.role,t.role FROM community_members a JOIN community_members t ON t.community_id=a.community_id WHERE a.community_id=$1 AND a.user_id=$2 AND t.user_id=$3 FOR UPDATE OF a,t`, id, actor, target).Scan(&actorRole, &targetRole); err != nil {
		return "", norm(err)
	}
	if actor == target || communityRank(actorRole) <= communityRank(targetRole) {
		return "", ErrForbidden
	}
	return actorRole, nil
}

func (s *PostgresStore) SetCommunityRole(id, actor, target, role string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 3); err != nil {
		return err
	}
	actorRole, err := communityTarget(ctx, tx, id, actor, target)
	if err != nil {
		return err
	}
	if communityRank(role) == 0 || role == "owner" || communityRank(role) >= communityRank(actorRole) {
		return ErrForbidden
	}
	if _, err = tx.Exec(ctx, `UPDATE community_members SET role=$3 WHERE community_id=$1 AND user_id=$2`, id, target, role); err != nil {
		return err
	}
	if err = auditCommunity(ctx, tx, id, actor, target, "set_role", role); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) AddCommunityMember(id, actor, target string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockSocialPairs(ctx, tx, []string{actor, target}); err != nil {
		return err
	}
	if _, err = lockCommunity(ctx, tx, id, actor, 2); err != nil {
		return err
	}
	var allowed bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM community_bans WHERE community_id=$1 AND user_id=$2)
 AND EXISTS(SELECT 1 FROM friend_requests WHERE status='accepted' AND ((sender_id=$3 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$3)))
 AND NOT EXISTS(SELECT 1 FROM user_blocks WHERE (blocker_id=$3 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$3))`, id, target, actor).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return ErrForbidden
	}
	if _, err = tx.Exec(ctx, `INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, id, target); err != nil {
		return err
	}
	if err = auditCommunity(ctx, tx, id, actor, target, "add_member", ""); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) RemoveCommunityMember(id, actor, target string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	minimum := 2
	if actor == target {
		minimum = 1
	}
	owner, err := lockCommunity(ctx, tx, id, actor, minimum)
	if err != nil {
		return err
	}
	if target == owner {
		return ErrForbidden
	}
	if actor != target {
		if _, err = communityTarget(ctx, tx, id, actor, target); err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM community_members WHERE community_id=$1 AND user_id=$2`, id, target)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err = auditCommunity(ctx, tx, id, actor, target, "remove_member", ""); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) TransferCommunityOwner(ctx context.Context, id, actor, target string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 4); err != nil {
		return err
	}
	if _, err = communityTarget(ctx, tx, id, actor, target); err != nil {
		return err
	}
	// Demote first to preserve the unique owner invariant in both statements.
	if _, err = tx.Exec(ctx, `UPDATE community_members SET role='admin' WHERE community_id=$1 AND user_id=$2`, id, actor); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE community_members SET role='owner',posting_restricted_until=NULL WHERE community_id=$1 AND user_id=$2`, id, target); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE communities SET owner_id=$2,updated_at=clock_timestamp() WHERE id=$1`, id, target); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE rooms SET owner_id=$2 WHERE community_id=$1`, id, target); err != nil {
		return err
	}
	if err = auditCommunity(ctx, tx, id, actor, target, "transfer_owner", ""); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) RoomPermission(room, user, permission string) error {
	var allowed bool
	if err := s.DB.QueryRow(context.Background(), `SELECT room_has_permission($1,$2,$3)`, room, user, permission).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return ErrForbidden
	}
	return nil
}
