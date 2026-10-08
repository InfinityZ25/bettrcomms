package api

import (
	"context"
	"time"
)

func (s *PostgresStore) SavePendingAttachment(room, user, key string, attachment MessageAttachment) error {
	return s.SavePendingAttachmentWithPolicy(room, user, key, attachment, "not_required")
}

func (s *PostgresStore) CompletePendingAttachment(id, room string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var user string
	if err = tx.QueryRow(ctx, `SELECT uploader_id::text FROM message_attachments WHERE id=$1 AND room_id=$2 AND uploader_id IS NOT NULL AND message_id IS NULL AND upload_state='uploading' AND deleted_at IS NULL`, id, room).Scan(&user); err != nil {
		return norm(err)
	}
	// Use the same posting authorization as a message, including announcement
	// permissions and moderation changes made while bytes were sent to S3.
	if err = checkRoomPosting(ctx, tx, room, user, false); err != nil {
		tx.Rollback(ctx)
		_ = s.DiscardPendingAttachment(ctx, id)
		return err
	}
	var ready string
	if err = tx.QueryRow(ctx, `UPDATE message_attachments SET upload_state='ready' WHERE id=$1 AND room_id=$2 AND uploader_id=$3 AND message_id IS NULL AND upload_state='uploading' AND scan_state IN('not_required','clean') AND deleted_at IS NULL RETURNING id::text`, id, room, user).Scan(&ready); err != nil {
		return norm(err)
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) RemovePendingAttachment(id string) error {
	return s.removePendingAttachment(context.Background(), id)
}

func (s *PostgresStore) removePendingAttachment(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM message_attachments a WHERE id=$1 AND message_id IS NULL AND NOT EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id) AND NOT EXISTS(SELECT 1 FROM attachment_uploads upload WHERE upload.id=a.id AND upload.finalize_until>clock_timestamp())`, id)
	return err
}

func (s *PostgresStore) DiscardPendingAttachment(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `UPDATE message_attachments a SET upload_state='ready',deleted_at=COALESCE(deleted_at,clock_timestamp()) WHERE id=$1 AND message_id IS NULL AND NOT EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id)`, id)
	return err
}

func (s *PostgresStore) CancelPendingAttachment(ctx context.Context, room, user, id string) (string, error) {
	var key string
	err := s.DB.QueryRow(ctx, `UPDATE message_attachments a SET deleted_at=COALESCE(deleted_at,clock_timestamp()) WHERE id=$1 AND room_id=$2 AND uploader_id=$3 AND message_id IS NULL AND upload_state='ready' AND can_access_room(room_id,$3) AND NOT EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id) RETURNING object_key`, id, room, user).Scan(&key)
	return key, norm(err)
}

func (s *PostgresStore) AttachmentForMember(room, user, id string) (string, MessageAttachment, error) {
	var key string
	var attachment MessageAttachment
	err := s.DB.QueryRow(context.Background(), `SELECT a.object_key,a.id::text,a.filename,a.content_type,a.size_bytes,a.voice_note,a.duration_ms FROM message_attachments a JOIN room_members rm ON rm.room_id=a.room_id AND rm.user_id=$2 LEFT JOIN messages m ON m.id=a.message_id WHERE a.room_id=$1 AND a.id=$3 AND can_access_room(a.room_id,$2) AND a.upload_state='ready' AND a.scan_state IN('not_required','clean') AND a.deleted_at IS NULL AND ((a.message_id IS NOT NULL AND m.deleted_at IS NULL) OR (a.message_id IS NULL AND a.uploader_id=$2 AND a.created_at>now()-interval '24 hours') OR EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id AND asset.room_id=a.room_id))`, room, user, id).Scan(&key, &attachment.ID, &attachment.Filename, &attachment.ContentType, &attachment.SizeBytes, &attachment.VoiceNote, &attachment.DurationMS)
	return key, attachment, norm(err)
}

func (s *PostgresStore) CleanPendingAttachments(ctx context.Context, storage AttachmentStorage) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Registration keeps healthy sources beyond upload expiry. Deleted or
	// ownerless sources still need physical cleanup; deleting their attachment
	// cascades through the asset and its message links only after S3 succeeds.
	rows, err := tx.Query(ctx, `SELECT a.id::text,a.object_key FROM message_attachments a
 WHERE NOT EXISTS(SELECT 1 FROM channel_media_assets asset
   WHERE asset.attachment_id=a.id AND asset.room_id=a.room_id
     AND a.upload_state='ready' AND a.scan_state IN('not_required','clean')
     AND a.deleted_at IS NULL AND a.uploader_id IS NOT NULL
     AND EXISTS(SELECT 1 FROM users uploader WHERE uploader.id=a.uploader_id AND uploader.deleted_at IS NULL))
 AND NOT EXISTS(SELECT 1 FROM attachment_uploads upload WHERE upload.id=a.id AND (upload.finalize_until>clock_timestamp() OR upload.state NOT IN('complete','cancelled','rejected') OR (upload.state IN('cancelled','rejected') AND upload.multipart_id IS NOT NULL)))
 AND ((a.message_id IS NULL AND a.created_at<now()-interval '24 hours') OR (a.upload_state='ready' AND (a.room_id IS NULL OR a.uploader_id IS NULL OR a.deleted_at IS NOT NULL)))
 ORDER BY COALESCE(a.cleanup_attempted_at,a.created_at) LIMIT 50 FOR UPDATE OF a SKIP LOCKED`)
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
