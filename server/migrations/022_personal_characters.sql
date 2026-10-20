ALTER TABLE users
 ADD COLUMN IF NOT EXISTS character_variant smallint NOT NULL DEFAULT 0 CHECK (character_variant BETWEEN 0 AND 5),
 ADD COLUMN IF NOT EXISTS character_hue smallint CHECK (character_hue BETWEEN 0 AND 359);
