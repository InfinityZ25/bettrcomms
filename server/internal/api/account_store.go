package api

import (
	"context"
	"time"
)

type DeviceSession struct {
	ID         string    `json:"id"`
	UserID     string    `json:"-"`
	DeviceName string    `json:"device_name"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	ExpiresAt  time.Time `json:"expires_at"`
	Current    bool      `json:"current"`
}
type ManagedSessions interface {
	CreateDeviceSession(context.Context, []byte, string, time.Time, string) error
	ResolveSession(context.Context, []byte, time.Time) (DeviceSession, error)
	ListDeviceSessions(context.Context, string, string) ([]DeviceSession, error)
	RevokeDeviceSessions(context.Context, string, string, bool) ([]string, error)
}

func (s *PostgresStore) CreateDeviceSession(ctx context.Context, hash []byte, user string, expires time.Time, device string) error {
	tag, err := s.DB.Exec(ctx, `INSERT INTO sessions(token_hash,user_id,expires_at,device_name) SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL)`, hash, user, expires, device)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrForbidden
	}
	return err
}
func (s *PostgresStore) ResolveSession(ctx context.Context, hash []byte, now time.Time) (DeviceSession, error) {
	var item DeviceSession
	err := s.DB.QueryRow(ctx, `SELECT s.id::text,s.user_id::text,s.device_name,s.created_at,s.last_seen_at,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.deleted_at IS NULL`, hash, now).Scan(&item.ID, &item.UserID, &item.DeviceName, &item.CreatedAt, &item.LastSeenAt, &item.ExpiresAt)
	if err == nil && now.Sub(item.LastSeenAt) >= 5*time.Minute {
		_, _ = s.DB.Exec(ctx, `UPDATE sessions SET last_seen_at=$2 WHERE token_hash=$1 AND last_seen_at<$2-interval '5 minutes'`, hash, now)
	}
	return item, norm(err)
}
func (s *PostgresStore) ListDeviceSessions(ctx context.Context, user, current string) ([]DeviceSession, error) {
	rows, err := s.DB.Query(ctx, `SELECT id::text,device_name,created_at,last_seen_at,expires_at FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 100`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeviceSession{}
	for rows.Next() {
		var item DeviceSession
		if err = rows.Scan(&item.ID, &item.DeviceName, &item.CreatedAt, &item.LastSeenAt, &item.ExpiresAt); err != nil {
			return nil, err
		}
		item.Current = item.ID == current
		out = append(out, item)
	}
	return out, rows.Err()
}
func (s *PostgresStore) RevokeDeviceSessions(ctx context.Context, user, id string, others bool) ([]string, error) {
	query := `DELETE FROM sessions WHERE user_id=$1 AND id=$2 RETURNING id::text`
	if others {
		query = `DELETE FROM sessions WHERE user_id=$1 AND id<>$2 RETURNING id::text`
	}
	rows, err := s.DB.Query(ctx, query, user, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *PostgresStore) TransferRoomOwner(ctx context.Context, room, actor, target string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = requireChannelOwner(ctx, tx, room, actor); err != nil {
		return err
	}
	var member string
	if err = tx.QueryRow(ctx, `SELECT rm.user_id::text FROM room_members rm JOIN users u ON u.id=rm.user_id WHERE rm.room_id=$1 AND rm.user_id=$2 AND u.deleted_at IS NULL FOR UPDATE OF rm`, room, target).Scan(&member); err != nil {
		return norm(err)
	}
	if actor == target {
		return ErrForbidden
	}
	if _, err = tx.Exec(ctx, `UPDATE rooms SET owner_id=$2 WHERE id=$1`, room, target); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE room_members SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'member' END WHERE room_id=$1 AND user_id IN ($2,$3)`, room, target, actor); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO room_moderation_audit(room_id,actor_id,target_id,action) VALUES($1,$2,$3,'transfer_owner')`, room, actor, target); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) DeleteAccount(ctx context.Context, user string) ([]string, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var id string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, user).Scan(&id); err != nil {
		return nil, norm(err)
	}
	var owns bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM rooms WHERE owner_id=$1 AND kind='channel')`, user).Scan(&owns); err != nil {
		return nil, err
	}
	if owns {
		return nil, ErrOwnedChannels
	}
	rows, err := tx.Query(ctx, `SELECT room_id::text FROM room_members WHERE user_id=$1`, user)
	if err != nil {
		return nil, err
	}
	rooms := []string{}
	for rows.Next() {
		var room string
		if err = rows.Scan(&room); err != nil {
			rows.Close()
			return nil, err
		}
		rooms = append(rooms, room)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	// Keep anonymous author/audit references. Personal content and device access
	// disappear atomically; S3 object keys survive for the bounded cleanup worker.
	for _, sql := range []string{
		`UPDATE users SET deleted_at=clock_timestamp(),workos_user_id=NULL,email='deleted-'||id::text||'@invalid.local',name='Deleted account',avatar_url=NULL,updated_at=clock_timestamp() WHERE id=$1`,
		`DELETE FROM sessions WHERE user_id=$1`,
		`UPDATE messages SET body='',deleted_at=COALESCE(deleted_at,clock_timestamp()),version=version+1 WHERE author_id=$1`,
		`UPDATE message_attachments SET deleted_at=clock_timestamp(),uploader_id=NULL WHERE uploader_id=$1`,
		`DELETE FROM message_mentions WHERE user_id=$1`,
		`DELETE FROM message_reactions WHERE user_id=$1`,
		`DELETE FROM room_reads WHERE user_id=$1`,
		`DELETE FROM thread_reads WHERE user_id=$1`,
		`DELETE FROM message_pins WHERE pinned_by=$1 OR message_id IN(SELECT id FROM messages WHERE author_id=$1)`,
		`DELETE FROM message_mentions WHERE message_id IN(SELECT id FROM messages WHERE author_id=$1)`,
		`DELETE FROM message_reactions WHERE message_id IN(SELECT id FROM messages WHERE author_id=$1)`,
		`DELETE FROM room_notification_preferences WHERE user_id=$1`,
		`DELETE FROM push_subscriptions WHERE user_id=$1`,
		`DELETE FROM friend_requests WHERE sender_id=$1 OR receiver_id=$1`,
		`DELETE FROM dm_requests WHERE sender_id=$1 OR receiver_id=$1`,
		`DELETE FROM user_blocks WHERE blocker_id=$1 OR blocked_id=$1`,
		`DELETE FROM room_bans WHERE user_id=$1`,
		`DELETE FROM message_reports WHERE reporter_id=$1`,
		`DELETE FROM room_members WHERE user_id=$1`,
		// Direct-room ownership is bookkeeping; it conveys no moderation privileges.
		`UPDATE rooms r SET owner_id=(SELECT rm.user_id FROM room_members rm WHERE rm.room_id=r.id ORDER BY rm.joined_at,rm.user_id LIMIT 1) WHERE r.owner_id=$1 AND r.kind='direct' AND EXISTS(SELECT 1 FROM room_members WHERE room_id=r.id)`,
		`DELETE FROM rooms r WHERE r.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM room_members WHERE room_id=r.id)`,
	} {
		if _, err = tx.Exec(ctx, sql, user); err != nil {
			return nil, err
		}
	}
	return rooms, tx.Commit(ctx)
}
