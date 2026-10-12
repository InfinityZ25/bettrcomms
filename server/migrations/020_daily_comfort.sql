CREATE TABLE IF NOT EXISTS personal_saved_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
 attachment_id uuid REFERENCES message_attachments(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((message_id IS NOT NULL)::integer+(attachment_id IS NOT NULL)::integer=1)
);
CREATE UNIQUE INDEX IF NOT EXISTS personal_saved_message ON personal_saved_items(user_id,message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS personal_saved_file ON personal_saved_items(user_id,attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS personal_saved_page ON personal_saved_items(user_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS personal_message_reminders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 due_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','due')),
 version bigint NOT NULL DEFAULT 1,
 mutation_id uuid NOT NULL,
 UNIQUE(user_id,message_id)
);
CREATE INDEX IF NOT EXISTS personal_reminders_due ON personal_message_reminders(due_at) WHERE state='pending';
CREATE INDEX IF NOT EXISTS personal_reminders_page ON personal_message_reminders(user_id,due_at,id);
CREATE TABLE IF NOT EXISTS personal_reminder_mutations (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 mutation_id uuid NOT NULL,
 message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 due_at timestamptz NOT NULL,
 reminder_id uuid REFERENCES personal_message_reminders(id) ON DELETE SET NULL,
 PRIMARY KEY(user_id,mutation_id)
);

CREATE TABLE IF NOT EXISTS account_quiet_hours (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 version bigint NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false,
 timezone text NOT NULL DEFAULT 'UTC',
 weekdays integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
 start_minute integer NOT NULL DEFAULT 1320 CHECK(start_minute BETWEEN 0 AND 1439),
 end_minute integer NOT NULL DEFAULT 480 CHECK(end_minute BETWEEN 0 AND 1439),
 CHECK(start_minute<>end_minute),
 CHECK(cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0,1,2,3,4,5,6])
);
ALTER TABLE room_notification_preferences ADD COLUMN IF NOT EXISTS muted_until timestamptz;
ALTER TABLE room_notification_preferences ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS account_draft_settings (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS account_text_drafts (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 thread_root_id uuid REFERENCES messages(id) ON DELETE CASCADE,
 scope_id uuid GENERATED ALWAYS AS (COALESCE(thread_root_id,'00000000-0000-0000-0000-000000000000'::uuid)) STORED,
 body text NOT NULL DEFAULT '' CHECK(char_length(body)<=4000),
 reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL,
 version bigint NOT NULL DEFAULT 1,
 mutation_id uuid NOT NULL,
 mutation_hash text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,room_id,scope_id)
);
CREATE INDEX IF NOT EXISTS account_drafts_page ON account_text_drafts(user_id,updated_at DESC,room_id,scope_id);

CREATE TABLE IF NOT EXISTS reminder_attention (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 personal_id uuid REFERENCES personal_message_reminders(id) ON DELETE CASCADE,
 event_reminder_id uuid REFERENCES channel_event_reminders(id) ON DELETE CASCADE,
 generation bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((personal_id IS NOT NULL)::integer+(event_reminder_id IS NOT NULL)::integer=1)
);
CREATE UNIQUE INDEX IF NOT EXISTS reminder_attention_personal ON reminder_attention(personal_id,generation) WHERE personal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reminder_attention_event ON reminder_attention(event_reminder_id) WHERE event_reminder_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS reminder_attention_devices (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id uuid NOT NULL,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 transport text NOT NULL CHECK(transport IN('page','desktop')),
 dnd boolean NOT NULL DEFAULT false,
 alerts boolean NOT NULL DEFAULT false,
 last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,device_id)
);
CREATE TABLE IF NOT EXISTS reminder_attention_deliveries (
 attention_id uuid NOT NULL REFERENCES reminder_attention(id) ON DELETE CASCADE,
 user_id uuid NOT NULL,
 device_id uuid NOT NULL,
 delivered_at timestamptz,
 lease_id uuid,
 lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(attention_id,user_id,device_id),
 FOREIGN KEY(user_id,device_id) REFERENCES reminder_attention_devices(user_id,device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS reminder_attention_pending ON reminder_attention_deliveries(user_id,device_id,next_attempt_at) WHERE delivered_at IS NULL;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS device_id uuid;

CREATE OR REPLACE FUNCTION daily_wall_boundary(day date,minute integer,zone text,latest boolean) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE desired timestamp; candidate timestamptz; result timestamptz;
BEGIN
 desired:=day::timestamp+make_interval(mins=>minute);
 candidate:=desired AT TIME ZONE zone;
 IF candidate AT TIME ZONE zone=desired AND
  (candidate AT TIME ZONE zone)-(candidate AT TIME ZONE 'UTC')=
  ((candidate-interval '3 hours') AT TIME ZONE zone)-((candidate-interval '3 hours') AT TIME ZONE 'UTC') THEN RETURN candidate; END IF;
 SELECT t INTO result FROM generate_series(candidate-interval '3 hours',candidate+interval '3 hours',interval '1 minute') t
 WHERE (t AT TIME ZONE zone)::date=day AND t AT TIME ZONE zone>=desired
 ORDER BY t AT TIME ZONE zone,CASE WHEN latest THEN -extract(epoch FROM t) ELSE extract(epoch FROM t) END LIMIT 1;
 RETURN COALESCE(result,candidate);
END $$;
CREATE OR REPLACE FUNCTION daily_quiet_active(account uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM account_quiet_hours q
 CROSS JOIN LATERAL(SELECT (instant AT TIME ZONE q.timezone)::date local_day) c
 CROSS JOIN LATERAL(SELECT c.local_day AS day UNION ALL SELECT c.local_day-1) days
 WHERE q.user_id=account AND q.enabled AND extract(dow FROM day)::integer=ANY(q.weekdays)
 AND instant>=daily_wall_boundary(day,q.start_minute,q.timezone,false)
 AND instant<daily_wall_boundary(day+CASE WHEN q.start_minute>q.end_minute THEN 1 ELSE 0 END,q.end_minute,q.timezone,true))
$$;
CREATE OR REPLACE FUNCTION daily_attention_allowed(account uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM users WHERE id=account AND deleted_at IS NULL AND presence_status<>'dnd') AND NOT daily_quiet_active(account,instant)
$$;
CREATE OR REPLACE FUNCTION daily_message_push_allowed(room uuid,account uuid,message uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT can_access_room(room,account) AND daily_attention_allowed(account,instant)
  AND EXISTS(SELECT 1 FROM messages WHERE id=message AND room_id=room AND deleted_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM room_notification_preferences p WHERE p.room_id=room AND p.user_id=account AND
   (p.mode='mute' OR p.muted_until>instant OR (p.mode='mentions' AND NOT EXISTS(SELECT 1 FROM message_mentions WHERE message_id=message AND user_id=account))))
$$;

CREATE OR REPLACE FUNCTION daily_comfort_message_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
  DELETE FROM personal_saved_items WHERE message_id=NEW.id;
  DELETE FROM personal_message_reminders WHERE message_id=NEW.id;
  DELETE FROM personal_reminder_mutations WHERE message_id=NEW.id;
  UPDATE account_text_drafts SET reply_to_id=NULL,version=version+1,updated_at=clock_timestamp() WHERE reply_to_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS daily_comfort_deleted_message ON messages;
CREATE TRIGGER daily_comfort_deleted_message AFTER UPDATE OF deleted_at ON messages FOR EACH ROW EXECUTE FUNCTION daily_comfort_message_deleted();
CREATE OR REPLACE FUNCTION daily_comfort_file_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
  DELETE FROM personal_saved_items WHERE attachment_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS daily_comfort_deleted_file ON message_attachments;
CREATE TRIGGER daily_comfort_deleted_file AFTER UPDATE OF deleted_at ON message_attachments FOR EACH ROW EXECUTE FUNCTION daily_comfort_file_deleted();
