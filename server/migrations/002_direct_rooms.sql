ALTER TABLE rooms ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel','direct'));
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS direct_key text;
CREATE UNIQUE INDEX IF NOT EXISTS rooms_direct_key_unique ON rooms(direct_key) WHERE direct_key IS NOT NULL;
