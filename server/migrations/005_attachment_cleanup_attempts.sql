ALTER TABLE message_attachments
  ADD COLUMN IF NOT EXISTS cleanup_attempted_at timestamptz;
