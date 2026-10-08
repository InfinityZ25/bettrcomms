package api

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var ErrInvalidPermissions = errors.New("invalid role or channel permissions")
var roleColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

type CustomRole struct {
	ID          string          `json:"id"`
	CommunityID string          `json:"community_id"`
	Name        string          `json:"name"`
	Color       string          `json:"color"`
	Permissions map[string]bool `json:"permissions"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}
type ChannelOverride struct {
	SubjectKey  string            `json:"subject_key"`
	Permissions map[string]string `json:"permissions"`
}
type ChannelAccess struct {
	IsPrivate        bool                     `json:"is_private"`
	Overrides        []ChannelOverride        `json:"overrides"`
	EffectiveMembers []EffectiveChannelMember `json:"effective_members,omitempty"`
}
type EffectiveChannelMember struct {
	UserID      string `json:"user_id"`
	Name        string `json:"name"`
	Role        string `json:"role"`
	Read        bool   `json:"read"`
	Post        bool   `json:"post"`
	JoinVoice   bool   `json:"join_voice"`
	PinMessages bool   `json:"pin_messages"`
}

func channelPermissionName(value string) bool {
	return value == "read" || value == "post" || value == "join_voice" || value == "pin_messages"
}
func validCustomRole(role CustomRole) bool {
	if strings.TrimSpace(role.Name) != role.Name || utf8.RuneCountInString(role.Name) < 1 || utf8.RuneCountInString(role.Name) > 60 || !roleColor.MatchString(role.Color) || communityRank(strings.ToLower(role.Name)) > 0 {
		return false
	}
	for permission := range role.Permissions {
		if !channelPermissionName(permission) {
			return false
		}
	}
	return true
}
func validChannelAccess(access ChannelAccess) bool {
	if len(access.Overrides) > 53 {
		return false
	}
	seen := map[string]bool{}
	for _, override := range access.Overrides {
		key := override.SubjectKey
		if seen[key] || (key != "everyone" && key != "moderator" && key != "member" && !uuidPattern.MatchString(key)) {
			return false
		}
		seen[key] = true
		if len(override.Permissions) == 0 {
			return false
		}
		for permission, value := range override.Permissions {
			if !channelPermissionName(permission) || (value != "allow" && value != "deny") {
				return false
			}
		}
	}
	return true
}

func (s *PostgresStore) CustomRoles(id, user string) ([]CustomRole, error) {
	if _, err := s.CommunityForMember(id, user); err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(context.Background(), `SELECT id::text,community_id::text,name,color,permissions,created_at,updated_at FROM community_roles WHERE community_id=$1 ORDER BY created_at,id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	roles := []CustomRole{}
	for rows.Next() {
		var role CustomRole
		if err = rows.Scan(&role.ID, &role.CommunityID, &role.Name, &role.Color, &role.Permissions, &role.CreatedAt, &role.UpdatedAt); err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}
	return roles, rows.Err()
}
func (s *PostgresStore) SaveCustomRole(id, actor, roleID string, role CustomRole) (CustomRole, error) {
	role.Name = strings.TrimSpace(role.Name)
	role.Color = strings.ToLower(role.Color)
	if !validCustomRole(role) {
		return CustomRole{}, ErrInvalidPermissions
	}
	if role.Permissions == nil {
		role.Permissions = map[string]bool{}
	}
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return CustomRole{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 3); err != nil {
		return CustomRole{}, err
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM community_roles WHERE community_id=$1`, id).Scan(&count); err != nil {
		return CustomRole{}, err
	}
	if roleID == "" && count >= 50 {
		return CustomRole{}, ErrInvalidPermissions
	}
	permissions, err := json.Marshal(role.Permissions)
	if err != nil {
		return CustomRole{}, err
	}
	var row pgx.Row
	if roleID == "" {
		row = tx.QueryRow(ctx, `INSERT INTO community_roles(community_id,name,color,permissions) VALUES($1,$2,$3,$4) RETURNING id::text,community_id::text,name,color,permissions,created_at,updated_at`, id, role.Name, role.Color, permissions)
	} else {
		row = tx.QueryRow(ctx, `UPDATE community_roles SET name=$3,color=$4,permissions=$5,updated_at=clock_timestamp() WHERE community_id=$1 AND id=$2 RETURNING id::text,community_id::text,name,color,permissions,created_at,updated_at`, id, roleID, role.Name, role.Color, permissions)
	}
	if err = row.Scan(&role.ID, &role.CommunityID, &role.Name, &role.Color, &role.Permissions, &role.CreatedAt, &role.UpdatedAt); err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" && databaseError.ConstraintName == "community_role_names" {
			return CustomRole{}, ErrInvalidPermissions
		}
		return CustomRole{}, norm(err)
	}
	if err = auditCommunity(ctx, tx, id, actor, "", "save_custom_role", role.ID); err != nil {
		return CustomRole{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CustomRole{}, err
	}
	return role, nil
}
func (s *PostgresStore) DeleteCustomRole(id, actor, role string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 3); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM community_roles WHERE community_id=$1 AND id=$2`, id, role)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `DELETE FROM channel_permission_overrides o USING rooms r WHERE o.room_id=r.id AND r.community_id=$1 AND o.subject_key=$2`, id, role); err != nil {
		return err
	}
	if err = auditCommunity(ctx, tx, id, actor, "", "delete_custom_role", role); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) SetMemberCustomRoles(id, actor, target string, roles []string) error {
	if len(roles) > 50 {
		return ErrInvalidPermissions
	}
	seen := map[string]bool{}
	for _, role := range roles {
		if !uuidPattern.MatchString(role) || seen[role] {
			return ErrInvalidPermissions
		}
		seen[role] = true
	}
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 3); err != nil {
		return err
	}
	if _, err = communityTarget(ctx, tx, id, actor, target); err != nil {
		return err
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM community_roles WHERE community_id=$1 AND id=ANY($2::uuid[])`, id, roles).Scan(&count); err != nil {
		return err
	}
	if count != len(roles) {
		return ErrInvalidPermissions
	}
	if _, err = tx.Exec(ctx, `DELETE FROM community_member_roles WHERE community_id=$1 AND user_id=$2`, id, target); err != nil {
		return err
	}
	if len(roles) > 0 {
		if _, err = tx.Exec(ctx, `INSERT INTO community_member_roles(community_id,user_id,role_id) SELECT $1,$2,unnest($3::uuid[])`, id, target, roles); err != nil {
			return err
		}
	}
	if err = auditCommunity(ctx, tx, id, actor, target, "set_custom_roles", strings.Join(roles, ",")); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) ChannelAccess(id, room, actor string) (ChannelAccess, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return ChannelAccess{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 3); err != nil {
		return ChannelAccess{}, err
	}
	access := ChannelAccess{Overrides: []ChannelOverride{}}
	if err = tx.QueryRow(ctx, `SELECT is_private FROM rooms WHERE community_id=$1 AND id=$2`, id, room).Scan(&access.IsPrivate); err != nil {
		return ChannelAccess{}, norm(err)
	}
	rows, err := tx.Query(ctx, `SELECT subject_key,permissions FROM channel_permission_overrides WHERE room_id=$1 ORDER BY subject_key`, room)
	if err != nil {
		return ChannelAccess{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var override ChannelOverride
		if err = rows.Scan(&override.SubjectKey, &override.Permissions); err != nil {
			return ChannelAccess{}, err
		}
		access.Overrides = append(access.Overrides, override)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return ChannelAccess{}, err
	}
	members, err := tx.Query(ctx, `SELECT m.user_id::text,u.name,m.role,can_access_room($2,m.user_id),room_has_permission($2,m.user_id,'post'),room_has_permission($2,m.user_id,'join_voice'),room_has_permission($2,m.user_id,'pin_messages') FROM community_members m JOIN users u ON u.id=m.user_id AND u.deleted_at IS NULL WHERE m.community_id=$1 ORDER BY u.name,m.user_id`, id, room)
	if err != nil {
		return ChannelAccess{}, err
	}
	defer members.Close()
	for members.Next() {
		var member EffectiveChannelMember
		if err = members.Scan(&member.UserID, &member.Name, &member.Role, &member.Read, &member.Post, &member.JoinVoice, &member.PinMessages); err != nil {
			return ChannelAccess{}, err
		}
		access.EffectiveMembers = append(access.EffectiveMembers, member)
	}
	return access, members.Err()
}
func (s *PostgresStore) SetChannelAccess(id, room, actor string, access ChannelAccess) error {
	if !validChannelAccess(access) {
		return ErrInvalidPermissions
	}
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockCommunity(ctx, tx, id, actor, 3); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE rooms SET is_private=$3 WHERE community_id=$1 AND id=$2`, id, room, access.IsPrivate)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `DELETE FROM channel_permission_overrides WHERE room_id=$1`, room); err != nil {
		return err
	}
	for _, override := range access.Overrides {
		if uuidPattern.MatchString(override.SubjectKey) {
			var exists bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_roles WHERE community_id=$1 AND id=$2)`, id, override.SubjectKey).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return ErrInvalidPermissions
			}
		}
		permissions, err := json.Marshal(override.Permissions)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO channel_permission_overrides(room_id,subject_key,permissions) VALUES($1,$2,$3)`, room, override.SubjectKey, permissions); err != nil {
			return err
		}
	}
	if err = auditCommunity(ctx, tx, id, actor, "", "set_channel_access", room); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
