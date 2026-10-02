package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const groupMemberLimit = 10

var ErrGroupFull = errors.New("group full")
var ErrInviteUnavailable = errors.New("invitation unavailable")
var ErrInviteLimit = errors.New("active invitation limit")

const activeInviteLimit = 20

type RoomInvite struct {
	ID        string     `json:"id"`
	RoomID    string     `json:"room_id"`
	CreatedAt time.Time  `json:"created_at"`
	ExpiresAt *time.Time `json:"expires_at"`
	MaxUses   int        `json:"max_uses"`
	Uses      int        `json:"uses"`
	RevokedAt *time.Time `json:"revoked_at"`
}
type InvitePreview struct {
	RoomID        string     `json:"room_id"`
	RoomName      string     `json:"room_name"`
	ExpiresAt     *time.Time `json:"expires_at"`
	RemainingUses *int       `json:"remaining_uses"`
	AlreadyMember bool       `json:"already_member"`
}
type SocialStore interface {
	CreateGroup(string, string, []string) (Room, error)
	ListInvites(string, string) ([]RoomInvite, error)
	CreateInvite(string, string, string, *time.Time, int) (RoomInvite, error)
	RevokeInvite(string, string, string) error
	PreviewInvite(string, string) (InvitePreview, error)
	RedeemInvite(string, string) (Room, bool, error)
}

func lockSocialPairs(ctx context.Context, tx pgx.Tx, ids []string) error {
	sort.Strings(ids)
	for i, left := range ids {
		for _, right := range ids[i+1:] {
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, directPairKey(left, right)); err != nil {
				return err
			}
		}
	}
	return nil
}

// Membership and blocking are infrequent administrative operations. Serialize
// their bounded transactions so a new member cannot appear between the block
// snapshot and pair checks. Message writes and media never take this lock.
func lockGroupMembership(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(83848732)`)
	return err
}
func groupPermitted(ctx context.Context, tx pgx.Tx, owner string, ids []string) (bool, error) {
	var allowed bool
	err := tx.QueryRow(ctx, `SELECT
 NOT EXISTS(SELECT 1 FROM unnest($2::uuid[]) target WHERE NOT EXISTS(SELECT 1 FROM users WHERE id=target AND deleted_at IS NULL)) AND
 NOT EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=ANY($2::uuid[]) AND blocked_id=ANY($2::uuid[])) AND
 NOT EXISTS(SELECT 1 FROM unnest($2::uuid[]) target WHERE target<>$1::uuid AND NOT EXISTS(
 SELECT 1 FROM friend_requests f WHERE status='accepted' AND ((sender_id=$1 AND receiver_id=target) OR (sender_id=target AND receiver_id=$1))))`, owner, ids).Scan(&allowed)
	return allowed, err
}
func (s *PostgresStore) CreateGroup(owner, name string, invitees []string) (Room, error) {
	owner = strings.ToLower(owner)
	if len(invitees) < 1 || len(invitees) >= groupMemberLimit {
		return Room{}, ErrGroupFull
	}
	ids := append([]string{owner}, invitees...)
	for i, id := range ids {
		ids[i] = strings.ToLower(id)
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !uuidPattern.MatchString(id) || seen[id] {
			return Room{}, ErrForbidden
		}
		seen[id] = true
	}
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Room{}, err
	}
	defer tx.Rollback(ctx)
	if err = lockGroupMembership(ctx, tx); err != nil {
		return Room{}, err
	}
	if err = lockSocialPairs(ctx, tx, ids); err != nil {
		return Room{}, err
	}
	allowed, err := groupPermitted(ctx, tx, owner, ids)
	if err != nil {
		return Room{}, err
	}
	if !allowed {
		return Room{}, ErrForbidden
	}
	var rid string
	if err = tx.QueryRow(ctx, `INSERT INTO rooms(name,owner_id,kind) VALUES($1,$2,'group') RETURNING id::text`, name, owner).Scan(&rid); err != nil {
		return Room{}, err
	}
	for _, id := range ids {
		role := "member"
		if id == owner {
			role = "owner"
		}
		if _, err = tx.Exec(ctx, `INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,$3)`, rid, id, role); err != nil {
			return Room{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Room{}, err
	}
	return s.RoomForMember(rid, owner)
}

func (s *PostgresStore) addMember(rid, owner, target string) error {
	rid, owner, target = strings.ToLower(rid), strings.ToLower(owner), strings.ToLower(target)
	if !uuidPattern.MatchString(target) || target == owner {
		return ErrForbidden
	}
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Authenticate before loading a roster or taking administrative locks.
	// Channel rosters are unbounded; only the owner/target relationship matters.
	var actualOwner, kind string
	if err = tx.QueryRow(ctx, `SELECT owner_id::text,kind FROM rooms WHERE id=$1`, rid).Scan(&actualOwner, &kind); err != nil {
		return norm(err)
	}
	if actualOwner != owner || (kind != "channel" && kind != "group") {
		return ErrForbidden
	}
	ids := []string{owner, target}
	if kind == "group" {
		if err = lockGroupMembership(ctx, tx); err != nil {
			return err
		}
		rows, queryErr := tx.Query(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 LIMIT $2`, rid, groupMemberLimit+1)
		if queryErr != nil {
			return queryErr
		}
		ids = []string{target}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(ids) > groupMemberLimit+1 {
			return ErrGroupFull
		}
	}
	// Pair locks precede room locks throughout group additions and blocking.
	if err = lockSocialPairs(ctx, tx, ids); err != nil {
		return err
	}
	if err = tx.QueryRow(ctx, `SELECT owner_id::text,kind FROM rooms WHERE id=$1 FOR UPDATE`, rid).Scan(&actualOwner, &kind); err != nil {
		return norm(err)
	}
	if actualOwner != owner || (kind != "channel" && kind != "group") {
		return ErrForbidden
	}
	var targetAllowed bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM room_bans WHERE room_id=$1 AND user_id=$2)`, rid, target).Scan(&targetAllowed); err != nil {
		return err
	}
	if !targetAllowed {
		return ErrForbidden
	}
	var already bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)`, rid, target).Scan(&already); err != nil {
		return err
	}
	if already {
		return tx.Commit(ctx)
	}
	var friend bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM friend_requests WHERE status='accepted' AND ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1))) AND NOT EXISTS(SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1))`, owner, target).Scan(&friend); err != nil {
		return err
	}
	if !friend {
		return ErrForbidden
	}
	if kind == "group" {
		var count int
		var blocked bool
		if err = tx.QueryRow(ctx, `SELECT count(*),EXISTS(SELECT 1 FROM room_members rm JOIN user_blocks b ON (b.blocker_id=rm.user_id AND b.blocked_id=$2) OR (b.blocker_id=$2 AND b.blocked_id=rm.user_id) WHERE rm.room_id=$1) FROM room_members WHERE room_id=$1`, rid, target).Scan(&count, &blocked); err != nil {
			return err
		}
		if blocked {
			return ErrForbidden
		}
		if count >= groupMemberLimit {
			return ErrGroupFull
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, rid, target); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func removeMemberTx(ctx context.Context, tx pgx.Tx, rid, actor, target string) error {
	var owner, kind string
	if err := tx.QueryRow(ctx, `SELECT owner_id::text,kind FROM rooms WHERE id=$1 FOR UPDATE`, rid).Scan(&owner, &kind); err != nil {
		return norm(err)
	}
	if kind == "direct" || (actor != owner && actor != target) || (target == owner && (kind != "group" || actor != target)) {
		return ErrForbidden
	}
	tag, err := tx.Exec(ctx, `DELETE FROM room_members WHERE room_id=$1 AND user_id=$2`, rid, target)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if target == owner {
		var next string
		err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 ORDER BY joined_at,user_id LIMIT 1 FOR UPDATE`, rid).Scan(&next)
		if errors.Is(err, pgx.ErrNoRows) {
			_, err = tx.Exec(ctx, `DELETE FROM rooms WHERE id=$1`, rid)
			return err
		}
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE rooms SET owner_id=$2 WHERE id=$1`, rid, next); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE room_members SET role='owner' WHERE room_id=$1 AND user_id=$2`, rid, next)
		return err
	}
	return nil
}
func (s *PostgresStore) removeMember(rid, actor, target string) error {
	rid, actor, target = strings.ToLower(rid), strings.ToLower(actor), strings.ToLower(target)
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockGroupMembership(ctx, tx); err != nil {
		return err
	}
	if err = removeMemberTx(ctx, tx, rid, actor, target); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func scanInvite(row pgx.Row) (RoomInvite, error) {
	var in RoomInvite
	err := row.Scan(&in.ID, &in.RoomID, &in.CreatedAt, &in.ExpiresAt, &in.MaxUses, &in.Uses, &in.RevokedAt)
	return in, norm(err)
}

const inviteCols = `id::text,room_id::text,created_at,expires_at,max_uses,uses,revoked_at`

func (s *PostgresStore) ListInvites(room, owner string) ([]RoomInvite, error) {
	var permitted bool
	err := s.DB.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM rooms WHERE id=$1 AND owner_id=$2 AND kind='channel')`, room, owner).Scan(&permitted)
	if err != nil {
		return nil, err
	}
	if !permitted {
		return nil, ErrForbidden
	}
	rows, err := s.DB.Query(context.Background(), `SELECT `+inviteCols+` FROM room_invites WHERE room_id=$1 ORDER BY (revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND (max_uses=0 OR uses<max_uses)) DESC,created_at DESC LIMIT 100`, room)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RoomInvite{}
	for rows.Next() {
		item, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func (s *PostgresStore) CreateInvite(room, owner, token string, expires *time.Time, max int) (RoomInvite, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return RoomInvite{}, err
	}
	defer tx.Rollback(ctx)
	var permitted string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM rooms WHERE id=$1 AND owner_id=$2 AND kind='channel' FOR UPDATE`, room, owner).Scan(&permitted); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RoomInvite{}, ErrForbidden
		}
		return RoomInvite{}, err
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM room_invites WHERE room_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND (max_uses=0 OR uses<max_uses)`, room).Scan(&count); err != nil {
		return RoomInvite{}, err
	}
	if count >= activeInviteLimit {
		return RoomInvite{}, ErrInviteLimit
	}
	hash := sha256.Sum256([]byte(token))
	item, err := scanInvite(tx.QueryRow(ctx, `INSERT INTO room_invites(room_id,creator_id,token_hash,expires_at,max_uses) VALUES($1,$2,$3,$4,$5) RETURNING `+inviteCols, room, owner, hash[:], expires, max))
	if err != nil {
		return RoomInvite{}, err
	}
	return item, tx.Commit(ctx)
}
func (s *PostgresStore) RevokeInvite(room, owner, id string) error {
	tag, err := s.DB.Exec(context.Background(), `UPDATE room_invites i SET revoked_at=COALESCE(revoked_at,now()) FROM rooms r WHERE i.id=$3 AND i.room_id=$1 AND r.id=i.room_id AND r.owner_id=$2 AND r.kind='channel'`, room, owner, id)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrForbidden
	}
	return err
}
func (s *PostgresStore) PreviewInvite(token, user string) (InvitePreview, error) {
	hash := sha256.Sum256([]byte(token))
	var out InvitePreview
	err := s.DB.QueryRow(context.Background(), `SELECT r.id::text,r.name,i.expires_at,CASE WHEN i.max_uses=0 THEN NULL ELSE greatest(i.max_uses-i.uses,0) END,EXISTS(SELECT 1 FROM room_members WHERE room_id=r.id AND user_id=$2)
 FROM room_invites i JOIN rooms r ON r.id=i.room_id WHERE i.token_hash=$1 AND r.kind='channel' AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at>now()) AND (i.max_uses=0 OR i.uses<i.max_uses OR EXISTS(SELECT 1 FROM room_members WHERE room_id=r.id AND user_id=$2))
 AND NOT EXISTS(SELECT 1 FROM user_blocks WHERE (blocker_id=$2 AND blocked_id=r.owner_id) OR (blocker_id=r.owner_id AND blocked_id=$2))
 AND NOT EXISTS(SELECT 1 FROM room_bans WHERE room_id=r.id AND user_id=$2)
 AND EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL)`, hash[:], user).Scan(&out.RoomID, &out.RoomName, &out.ExpiresAt, &out.RemainingUses, &out.AlreadyMember)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrInviteUnavailable
	}
	return out, err
}
func (s *PostgresStore) RedeemInvite(token, user string) (Room, bool, error) {
	ctx := context.Background()
	hash := sha256.Sum256([]byte(token))
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Room{}, false, err
	}
	defer tx.Rollback(ctx)
	var room, owner string
	if err = tx.QueryRow(ctx, `SELECT r.id::text,r.owner_id::text FROM room_invites i JOIN rooms r ON r.id=i.room_id WHERE token_hash=$1 AND r.kind='channel'`, hash[:]).Scan(&room, &owner); err != nil {
		return Room{}, false, ErrInviteUnavailable
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, directPairKey(owner, user)); err != nil {
		return Room{}, false, err
	}
	// Lock room before invite, consistently with deletion/revocation, then lease a use.
	if err = tx.QueryRow(ctx, `SELECT owner_id::text FROM rooms WHERE id=$1 AND kind='channel' FOR UPDATE`, room).Scan(&owner); err != nil {
		return Room{}, false, ErrInviteUnavailable
	}
	var id string
	var max, uses int
	var expires, revoked *time.Time
	if err = tx.QueryRow(ctx, `SELECT id::text,max_uses,uses,expires_at,revoked_at FROM room_invites WHERE token_hash=$1 FOR UPDATE`, hash[:]).Scan(&id, &max, &uses, &expires, &revoked); err != nil {
		return Room{}, false, ErrInviteUnavailable
	}
	if revoked != nil || (expires != nil && !expires.After(time.Now())) {
		return Room{}, false, ErrInviteUnavailable
	}
	var blocked, member, accountAllowed bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)),EXISTS(SELECT 1 FROM room_members WHERE room_id=$3 AND user_id=$2),EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM room_bans WHERE room_id=$3 AND user_id=$2)`, owner, user, room).Scan(&blocked, &member, &accountAllowed); err != nil {
		return Room{}, false, err
	}
	if blocked || !accountAllowed {
		return Room{}, false, ErrForbidden
	}
	if !member {
		if max > 0 && uses >= max {
			return Room{}, false, ErrInviteUnavailable
		}
		if _, err = tx.Exec(ctx, `INSERT INTO room_members(room_id,user_id) VALUES($1,$2)`, room, user); err != nil {
			return Room{}, false, err
		}
		if _, err = tx.Exec(ctx, `UPDATE room_invites SET uses=uses+1 WHERE id=$1`, id); err != nil {
			return Room{}, false, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Room{}, false, err
	}
	result, err := s.RoomForMember(room, user)
	return result, !member, err
}
