CREATE TABLE IF NOT EXISTS community_storage_policies (
  community_id uuid PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  quota_bytes bigint NOT NULL DEFAULT 0 CHECK (quota_bytes BETWEEN 0 AND 8796093022208),
  retention_days integer NOT NULL DEFAULT 0 CHECK (retention_days BETWEEN 0 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS scan_state text NOT NULL DEFAULT 'not_required'
  CHECK (scan_state IN ('not_required','pending','clean','rejected'));
CREATE TABLE IF NOT EXISTS attachment_uploads (
  id uuid PRIMARY KEY REFERENCES message_attachments(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  multipart_id text,
  offset_bytes bigint NOT NULL DEFAULT 0 CHECK (offset_bytes >= 0),
  state text NOT NULL DEFAULT 'creating' CHECK (state IN ('creating','uploading','assembled','complete','cancelled','rejected')),
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE TABLE IF NOT EXISTS attachment_upload_parts (
  upload_id uuid NOT NULL REFERENCES attachment_uploads(id) ON DELETE CASCADE,
  part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  offset_bytes bigint NOT NULL CHECK (offset_bytes >= 0),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  etag text NOT NULL,
  PRIMARY KEY(upload_id,part_number),
  UNIQUE(upload_id,offset_bytes)
);
CREATE INDEX IF NOT EXISTS attachment_uploads_expiry ON attachment_uploads(expires_at);
ALTER TABLE attachment_uploads ADD COLUMN IF NOT EXISTS finalize_until timestamptz;
ALTER TABLE attachment_uploads ADD COLUMN IF NOT EXISTS finalize_token uuid;
CREATE INDEX IF NOT EXISTS message_attachments_library ON message_attachments(room_id,created_at DESC,id DESC)
  WHERE deleted_at IS NULL AND upload_state='ready';
