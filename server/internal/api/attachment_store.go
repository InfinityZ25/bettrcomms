package api

import (
	"context"
	"time"
)

func (s *PostgresStore) SavePendingAttachment(room, user, key string, attachment MessageAttachment) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = checkRoomPosting(ctx, tx, room, user, false); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO message_attachments(id,room_id,uploader_id,object_key,filename,content_type,size_bytes,upload_state) SELECT $1,$2,$3,$4,$5,$6,$7,'uploading' WHERE can_access_room($2,$3)`, attachment.ID, room, user, key, attachment.Filename, attachment.ContentType, attachment.SizeBytes)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) CompletePendingAttachment(id, room string) error {
	var currentRoom *string
	var deleted *time.Time
	err := s.DB.QueryRow(context.Background(), `UPDATE message_attachments a SET upload_state='ready',deleted_at=CASE WHEN can_access_room(a.room_id,a.uploader_id) AND EXISTS(SELECT 1 FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=a.uploader_id WHERE r.id=a.room_id AND (r.owner_id=a.uploader_id OR rm.posting_restricted_until IS NULL OR rm.posting_restricted_until<=clock_timestamp())) THEN deleted_at ELSE clock_timestamp() END WHERE id=$1 RETURNING room_id::text,deleted_at`, id).Scan(&currentRoom, &deleted)
	if err != nil {
		return norm(err)
	}
	if currentRoom == nil || *currentRoom != room || deleted != nil {
		return ErrForbidden
	}
	return nil
}

func (s *PostgresStore) RemovePendingAttachment(id string) error {
	_, err := s.DB.Exec(context.Background(), `DELETE FROM message_attachments WHERE id=$1 AND message_id IS NULL`, id)
	return err
}

func (s *PostgresStore) AttachmentForMember(room, user, id string) (string, MessageAttachment, error) {
	var key string
	var attachment MessageAttachment
	err := s.DB.QueryRow(context.Background(), `SELECT a.object_key,a.id::text,a.filename,a.content_type,a.size_bytes FROM message_attachments a JOIN room_members rm ON rm.room_id=a.room_id AND rm.user_id=$2 LEFT JOIN messages m ON m.id=a.message_id WHERE a.room_id=$1 AND a.id=$3 AND a.upload_state='ready' AND a.deleted_at IS NULL AND ((a.message_id IS NOT NULL AND m.deleted_at IS NULL) OR (a.message_id IS NULL AND a.uploader_id=$2 AND a.created_at>now()-interval '24 hours'))`, room, user, id).Scan(&key, &attachment.ID, &attachment.Filename, &attachment.ContentType, &attachment.SizeBytes)
	return key, attachment, norm(err)
}

func (s *PostgresStore) CleanPendingAttachments(ctx context.Context, storage AttachmentStorage) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id::text,object_key FROM message_attachments WHERE (message_id IS NULL AND created_at<now()-interval '24 hours') OR (upload_state='ready' AND (room_id IS NULL OR uploader_id IS NULL OR deleted_at IS NOT NULL)) ORDER BY COALESCE(cleanup_attempted_at,created_at) LIMIT 50 FOR UPDATE SKIP LOCKED`)
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
