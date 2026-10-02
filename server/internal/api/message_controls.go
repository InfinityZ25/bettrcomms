package api

import (
	"context"
	"time"
)

type MessageReport struct {
	ID           string    `json:"id"`
	MessageID    string    `json:"message_id"`
	ReporterName string    `json:"reporter_name"`
	AuthorName   string    `json:"author_name"`
	Excerpt      string    `json:"excerpt"`
	Reason       string    `json:"reason"`
	CreatedAt    time.Time `json:"created_at"`
}

func (s *PostgresStore) ReportMessage(room, user, id, reason string) error {
	tag, err := s.DB.Exec(context.Background(), `INSERT INTO message_reports(room_id,message_id,reporter_id,reason)
		SELECT m.room_id,m.id,$2,$4 FROM messages m JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$2
		WHERE m.room_id=$1 AND m.id=$3 AND m.author_id<>$2 AND m.deleted_at IS NULL
		ON CONFLICT(message_id,reporter_id) DO UPDATE SET reason=EXCLUDED.reason,status='open'`, room, user, id, reason)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (s *PostgresStore) ListMessageReports(room, user string) ([]MessageReport, error) {
	var owner string
	if err := s.DB.QueryRow(context.Background(), `SELECT owner_id::text FROM rooms WHERE id=$1 AND kind='channel'`, room).Scan(&owner); err != nil {
		return nil, norm(err)
	}
	if owner != user {
		return nil, ErrForbidden
	}
	rows, err := s.DB.Query(context.Background(), `SELECT r.id::text,r.message_id::text,reporter.name,author.name,COALESCE(NULLIF(left(m.body,180),''),'[attachment]'),r.reason,r.created_at
		FROM message_reports r JOIN messages m ON m.id=r.message_id JOIN users reporter ON reporter.id=r.reporter_id
		JOIN users author ON author.id=m.author_id WHERE r.room_id=$1 AND r.status='open' ORDER BY r.created_at DESC LIMIT 100`, room)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []MessageReport{}
	for rows.Next() {
		var report MessageReport
		if err = rows.Scan(&report.ID, &report.MessageID, &report.ReporterName, &report.AuthorName, &report.Excerpt, &report.Reason, &report.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, report)
	}
	return result, rows.Err()
}

func (s *PostgresStore) ModerateMessage(room, actor, id, reason string) (Message, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))`, room); err != nil {
		return Message{}, err
	}
	var owner string
	if err = tx.QueryRow(ctx, `SELECT owner_id::text FROM rooms WHERE id=$1 AND kind='channel' FOR SHARE`, room).Scan(&owner); err != nil {
		return Message{}, norm(err)
	}
	if owner != actor {
		return Message{}, ErrForbidden
	}
	var found string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM messages WHERE room_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, room, id).Scan(&found); err != nil {
		return Message{}, norm(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE messages SET body='',deleted_at=clock_timestamp(),version=version+1 WHERE id=$1`, id); err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM message_pins WHERE message_id=$1`, id); err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE messages SET version=version+1 WHERE id=(SELECT thread_root_id FROM messages WHERE id=$1)`, id); err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE message_attachments SET deleted_at=clock_timestamp() WHERE message_id=$1 AND deleted_at IS NULL`, id); err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE message_reports SET status='resolved' WHERE message_id=$1 AND status='open'`, id); err != nil {
		return Message{}, err
	}
	for _, table := range []string{"message_mentions", "message_reactions"} {
		if _, err = tx.Exec(ctx, `DELETE FROM `+table+` WHERE message_id=$1`, id); err != nil {
			return Message{}, err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO message_moderation_audit(room_id,message_id,actor_id,action,reason) VALUES($1,$2,$3,'remove',$4)`, room, id, actor, reason); err != nil {
		return Message{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Message{}, err
	}
	return s.MessageByID(room, id)
}

func (s *PostgresStore) DismissMessageReport(room, actor, reportID string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var owner string
	if err = tx.QueryRow(ctx, `SELECT owner_id::text FROM rooms WHERE id=$1 AND kind='channel' FOR SHARE`, room).Scan(&owner); err != nil {
		return norm(err)
	}
	if owner != actor {
		return ErrForbidden
	}
	var messageID string
	if err = tx.QueryRow(ctx, `UPDATE message_reports SET status='dismissed' WHERE id=$1 AND room_id=$2 AND status='open' RETURNING message_id::text`, reportID, room).Scan(&messageID); err != nil {
		return norm(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO message_moderation_audit(room_id,message_id,actor_id,action,reason) VALUES($1,$2,$3,'dismiss_report','Reviewed and dismissed')`, room, messageID, actor); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) NotificationPreferences(user string) (map[string]string, error) {
	rows, err := s.DB.Query(context.Background(), `SELECT p.room_id::text,p.mode FROM room_notification_preferences p JOIN room_members rm ON rm.room_id=p.room_id AND rm.user_id=p.user_id WHERE p.user_id=$1`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]string{}
	for rows.Next() {
		var room, mode string
		if err = rows.Scan(&room, &mode); err != nil {
			return nil, err
		}
		result[room] = mode
	}
	return result, rows.Err()
}

func (s *PostgresStore) SetNotificationPreference(room, user, mode string) error {
	tag, err := s.DB.Exec(context.Background(), `INSERT INTO room_notification_preferences(room_id,user_id,mode)
		SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)
		ON CONFLICT(room_id,user_id) DO UPDATE SET mode=EXCLUDED.mode`, room, user, mode)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrForbidden
	}
	return err
}
