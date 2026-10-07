package api

import (
	"context"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

type PostingError struct {
	Code  string
	Until time.Time
}

func (e *PostingError) Error() string { return e.Code }
func (e *PostingError) RetrySeconds() int {
	return max(1, int(math.Ceil(time.Until(e.Until).Seconds())))
}

type RoomBan struct {
	User      User      `json:"user"`
	Reason    string    `json:"reason"`
	CreatedAt time.Time `json:"created_at"`
}
type ModerationState struct {
	SlowModeSeconds int        `json:"slow_mode_seconds"`
	RestrictedUntil *time.Time `json:"restricted_until"`
	NextPostAt      *time.Time `json:"next_post_at"`
}
type ModerationAudit struct {
	Action     string    `json:"action"`
	ActorName  string    `json:"actor_name"`
	TargetName *string   `json:"target_name"`
	Reason     string    `json:"reason"`
	CreatedAt  time.Time `json:"created_at"`
}

// All content writes call this inside their transaction. A member-row lock
// serializes cooldowns across devices; no polling or expiry cleanup is needed.
func lockRoomCommunity(ctx context.Context, tx pgx.Tx, room string) error {
	var parent *string
	if err := tx.QueryRow(ctx, `SELECT community_id::text FROM rooms WHERE id=$1`, room).Scan(&parent); err != nil {
		return norm(err)
	}
	if parent != nil {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM communities WHERE id=$1 FOR SHARE`, *parent).Scan(&locked); err != nil {
			return norm(err)
		}
	}
	return nil
}

func checkRoomPosting(ctx context.Context, tx pgx.Tx, room, user string, newMessage bool) error {
	if err := lockRoomCommunity(ctx, tx, room); err != nil {
		return err
	}
	var kind string
	var slow int
	if err := tx.QueryRow(ctx, `SELECT kind,slow_mode_seconds FROM rooms WHERE id=$1 FOR SHARE`, room).Scan(&kind, &slow); err != nil {
		return norm(err)
	}
	var restricted, last *time.Time
	var active, exempt bool
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT rm.posting_restricted_until,rm.last_posted_at,room_has_permission($1,$2,'post'),room_has_permission($1,$2,'manage_channels'),clock_timestamp() FROM room_members rm WHERE rm.room_id=$1 AND rm.user_id=$2 FOR UPDATE`, room, user).Scan(&restricted, &last, &active, &exempt, &now); err != nil {
		return ErrForbidden
	}
	if !active {
		return ErrForbidden
	}
	if kind != "channel" || exempt {
		return nil
	}
	if restricted != nil && restricted.After(now) {
		return &PostingError{Code: "posting_restricted", Until: *restricted}
	}
	if !newMessage {
		return nil
	}
	if slow > 0 && last != nil && last.Add(time.Duration(slow)*time.Second).After(now) {
		return &PostingError{Code: "slow_mode", Until: last.Add(time.Duration(slow) * time.Second)}
	}
	_, err := tx.Exec(ctx, `UPDATE room_members SET last_posted_at=clock_timestamp() WHERE room_id=$1 AND user_id=$2`, room, user)
	return err
}

func (s *PostgresStore) PostingState(room, user string) (ModerationState, error) {
	var state ModerationState
	var last *time.Time
	var exempt bool
	err := s.DB.QueryRow(context.Background(), `SELECT r.slow_mode_seconds,rm.posting_restricted_until,rm.last_posted_at,room_has_permission(r.id,$2,'manage_channels') FROM rooms r JOIN room_members rm ON rm.room_id=r.id WHERE r.id=$1 AND rm.user_id=$2 AND can_access_room(r.id,$2)`, room, user).Scan(&state.SlowModeSeconds, &state.RestrictedUntil, &last, &exempt)
	if exempt {
		state.RestrictedUntil = nil
		state.NextPostAt = nil
		return state, norm(err)
	}
	if last != nil && state.SlowModeSeconds > 0 {
		next := last.Add(time.Duration(state.SlowModeSeconds) * time.Second)
		state.NextPostAt = &next
	}
	return state, norm(err)
}
func requireChannelOwner(ctx context.Context, tx pgx.Tx, room, actor string) error {
	var owner string
	err := tx.QueryRow(ctx, `SELECT owner_id::text FROM rooms WHERE id=$1 AND kind='channel' FOR UPDATE`, room).Scan(&owner)
	if err != nil {
		return norm(err)
	}
	if owner != actor {
		return ErrForbidden
	}
	return nil
}
func requireChannelRole(ctx context.Context, tx pgx.Tx, room, actor string, minimum int) (string, error) {
	var parent string
	if err := tx.QueryRow(ctx, `SELECT community_id::text FROM rooms WHERE id=$1 AND kind='channel'`, room).Scan(&parent); err != nil {
		return "", norm(err)
	}
	if _, err := lockCommunity(ctx, tx, parent, actor, minimum); err != nil {
		return "", err
	}
	return parent, nil
}
func (s *PostgresStore) ModerateMember(room, actor, target, action, reason string, duration int) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	parent, err := requireChannelRole(ctx, tx, room, actor, 2)
	if err != nil {
		return err
	}
	if target == actor {
		return ErrForbidden
	}
	var owner string
	if err = tx.QueryRow(ctx, `SELECT owner_id::text FROM communities WHERE id=$1`, parent).Scan(&owner); err != nil {
		return err
	}
	if target == owner {
		return ErrForbidden
	}
	var member bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2)`, parent, target).Scan(&member); err != nil {
		return err
	}
	if member {
		if _, err = communityTarget(ctx, tx, parent, actor, target); err != nil {
			return err
		}
	} else if action != "unban" && action != "ban" {
		return ErrNotFound
	}
	switch action {
	case "ban":
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT $3::boolean OR EXISTS(SELECT 1 FROM community_bans WHERE community_id=$1 AND user_id=$2)`, parent, target, member).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		if _, err = tx.Exec(ctx, `INSERT INTO community_bans(community_id,user_id,actor_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT(community_id,user_id) DO UPDATE SET reason=EXCLUDED.reason,actor_id=EXCLUDED.actor_id`, parent, target, actor, reason); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM community_members WHERE community_id=$1 AND user_id=$2`, parent, target); err != nil {
			return err
		}
	case "unban":
		tag, e := tx.Exec(ctx, `DELETE FROM community_bans WHERE community_id=$1 AND user_id=$2`, parent, target)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		if _, err = tx.Exec(ctx, `DELETE FROM room_bans WHERE room_id IN(SELECT id FROM rooms WHERE community_id=$1) AND user_id=$2`, parent, target); err != nil {
			return err
		}
	case "timeout", "clear_timeout":
		tag, e := tx.Exec(ctx, `UPDATE community_members SET posting_restricted_until=CASE WHEN $3>0 THEN clock_timestamp()+($3*interval '1 second') ELSE NULL END WHERE community_id=$1 AND user_id=$2`, parent, target, duration)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
	default:
		return ErrForbidden
	}
	if err = auditCommunity(ctx, tx, parent, actor, target, action, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) SetSlowMode(room, actor string, seconds int) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	parent, err := requireChannelRole(ctx, tx, room, actor, 3)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE rooms SET slow_mode_seconds=$2 WHERE id=$1`, room, seconds); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO room_moderation_audit(room_id,actor_id,action,reason) VALUES($1,$2,'slow_mode',$3)`, room, actor, (time.Duration(seconds) * time.Second).String()); err != nil {
		return err
	}
	if err = auditCommunity(ctx, tx, parent, actor, "", "slow_mode", (time.Duration(seconds) * time.Second).String()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) RoomModeration(room, actor, after string) ([]RoomBan, []ModerationAudit, string, error) {
	if err := s.RoomPermission(room, actor, "moderate"); err != nil {
		return nil, nil, "", err
	}
	var cursor any
	if after != "" {
		cursor = after
	}
	rows, err := s.DB.Query(context.Background(), `SELECT u.id::text,u.email,u.name,u.avatar_url,u.created_at,b.reason,b.created_at FROM community_bans b JOIN users u ON u.id=b.user_id WHERE b.community_id=(SELECT community_id FROM rooms WHERE id=$1) AND ($2::uuid IS NULL OR b.user_id>$2::uuid) ORDER BY b.user_id LIMIT 51`, room, cursor)
	if err != nil {
		return nil, nil, "", err
	}
	bans := []RoomBan{}
	for rows.Next() {
		var b RoomBan
		if err = rows.Scan(&b.User.ID, &b.User.Email, &b.User.Name, &b.User.AvatarURL, &b.User.CreatedAt, &b.Reason, &b.CreatedAt); err != nil {
			rows.Close()
			return nil, nil, "", err
		}
		bans = append(bans, b)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, "", err
	}
	next := ""
	if len(bans) > 50 {
		bans = bans[:50]
		next = bans[len(bans)-1].User.ID
	}
	rows, err = s.DB.Query(context.Background(), `SELECT a.action,actor.name,target.name,a.detail,a.created_at FROM community_audit a JOIN users actor ON actor.id=a.actor_id LEFT JOIN users target ON target.id=a.target_id WHERE a.community_id=(SELECT community_id FROM rooms WHERE id=$1) ORDER BY a.created_at DESC,a.id DESC LIMIT 100`, room)
	if err != nil {
		return nil, nil, "", err
	}
	defer rows.Close()
	audit := []ModerationAudit{}
	for rows.Next() {
		var item ModerationAudit
		if err = rows.Scan(&item.Action, &item.ActorName, &item.TargetName, &item.Reason, &item.CreatedAt); err != nil {
			return nil, nil, "", err
		}
		audit = append(audit, item)
	}
	return bans, audit, next, rows.Err()
}
func (s *PostgresStore) CheckPosting(room, user string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	err = checkRoomPosting(ctx, tx, room, user, false)
	return err
}
