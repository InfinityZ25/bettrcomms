-- Preserve object keys when a room, uploader, or message is physically deleted.
-- The cleanup worker removes the S3 object before deleting this row.
ALTER TABLE message_attachments DROP CONSTRAINT IF EXISTS message_attachments_room_id_fkey;
ALTER TABLE message_attachments DROP CONSTRAINT IF EXISTS message_attachments_uploader_id_fkey;
ALTER TABLE message_attachments DROP CONSTRAINT IF EXISTS message_attachments_message_id_fkey;
ALTER TABLE message_attachments ALTER COLUMN room_id DROP NOT NULL;
ALTER TABLE message_attachments ALTER COLUMN uploader_id DROP NOT NULL;
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_room_id_fkey
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL;
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_uploader_id_fkey
  FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS upload_state text NOT NULL DEFAULT 'ready';
ALTER TABLE message_attachments DROP CONSTRAINT IF EXISTS message_attachments_upload_state_check;
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_upload_state_check
  CHECK (upload_state IN ('uploading', 'ready'));
