-- The API defaults ordinary files to 500 MiB and permits an explicit server
-- limit up to 2 GiB. Voice notes retain their independently bounded parser.
ALTER TABLE message_attachments DROP CONSTRAINT IF EXISTS message_attachments_size_bytes_check;
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_size_bytes_check
  CHECK (size_bytes BETWEEN 1 AND 2147483648);
ALTER TABLE message_attachments DROP CONSTRAINT IF EXISTS voice_note_size;
ALTER TABLE message_attachments ADD CONSTRAINT voice_note_size
  CHECK (NOT voice_note OR size_bytes <= 10485760);
