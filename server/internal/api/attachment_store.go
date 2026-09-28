package api

import (
	"context"
	"time"
)

func (s *PostgresStore) SavePendingAttachment(room, user, key string, attachment MessageAttachment) error {
	tag, err := s.DB.Exec(context.Background(), `INSERT INTO message_attachments(id,room_id,uploader_id,object_key,filename,content_type,size_bytes) SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS(SELECT 1 FROM room_members WHERE room_id=$2 AND user_id=$3)`, attachment.ID, room, user, key, attachment.Filename, attachment.ContentType, attachment.SizeBytes)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrForbidden
	}
	return err
}

func (s *PostgresStore) RemovePendingAttachment(id string) error {
	_, err := s.DB.Exec(context.Background(), `DELETE FROM message_attachments WHERE id=$1 AND message_id IS NULL`, id)
	return err
}

func (s *PostgresStore) AttachmentForMember(room, user, id string) (string, MessageAttachment, error) {
	var key string
	var attachment MessageAttachment
	err := s.DB.QueryRow(context.Background(), `SELECT a.object_key,a.id::text,a.filename,a.content_type,a.size_bytes FROM message_attachments a JOIN room_members rm ON rm.room_id=a.room_id AND rm.user_id=$2 LEFT JOIN messages m ON m.id=a.message_id WHERE a.room_id=$1 AND a.id=$3 AND a.deleted_at IS NULL AND ((a.message_id IS NOT NULL AND m.deleted_at IS NULL) OR (a.message_id IS NULL AND a.uploader_id=$2 AND a.created_at>now()-interval '24 hours'))`, room, user, id).Scan(&key, &attachment.ID, &attachment.Filename, &attachment.ContentType, &attachment.SizeBytes)
	return key, attachment, norm(err)
}

func (s *PostgresStore) CleanPendingAttachments(ctx context.Context, storage AttachmentStorage) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id::text,object_key FROM message_attachments WHERE (message_id IS NULL AND created_at<now()-interval '24 hours') OR deleted_at IS NOT NULL ORDER BY COALESCE(cleanup_attempted_at,created_at) LIMIT 50 FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return err
	}
	type stale struct{ id, key string }
	var items []stale
	for rows.Next() {
		var item stale
		if err = rows.Scan(&item.id, &item.key); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var firstDeleteErr error
	for _, item := range items {
		deleteCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err = storage.Delete(deleteCtx, item.key)
		cancel()
		if err != nil {
			if firstDeleteErr == nil {
				firstDeleteErr = err
			}
			if _, err = tx.Exec(ctx, `UPDATE message_attachments SET cleanup_attempted_at=clock_timestamp() WHERE id=$1`, item.id); err != nil {
				return err
			}
			continue
		}
		if _, err = tx.Exec(ctx, `DELETE FROM message_attachments WHERE id=$1`, item.id); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return firstDeleteErr
}
