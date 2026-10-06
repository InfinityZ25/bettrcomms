-- Quoted-message replies and thread replies are independent recipient paths.
-- Keep the existing quote index and add the thread path for activity pagination.
CREATE INDEX IF NOT EXISTS messages_thread_activity ON messages(thread_root_id,created_at DESC,id DESC) WHERE thread_root_id IS NOT NULL AND deleted_at IS NULL;
DROP INDEX IF EXISTS messages_activity_parent;
