package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *PostgresStore) activityTx(room, user string, post, voice bool) (pgx.Tx, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if post {
		err = checkRoomPosting(ctx, tx, room, user, false)
	} else {
		err = lockRoomCommunity(ctx, tx, room)
		if err == nil {
			var member string
			err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 AND can_access_room(room_id,$2) FOR SHARE`, room, user).Scan(&member)
			if errors.Is(err, pgx.ErrNoRows) {
				err = ErrForbidden
			}
		}
	}
	if err == nil && voice {
		var allowed bool
		err = tx.QueryRow(ctx, `SELECT room_has_permission($1,$2,'join_voice')`, room, user).Scan(&allowed)
		if err == nil && !allowed {
			err = ErrForbidden
		}
	}
	if err != nil {
		tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

func (s *PostgresStore) ChannelActivities(room, user string) (ChannelActivitySnapshot, error) {
	out := ChannelActivitySnapshot{Polls: []ChannelPoll{}, Events: []ScheduledChannelEvent{}, Assets: []ChannelMediaAsset{}}
	if _, err := s.RoomForMember(room, user); err != nil {
		return out, err
	}
	ctx := context.Background()
	rows, err := s.DB.Query(ctx, `SELECT p.id::text,p.author_id::text,p.question,p.options,p.created_at,p.closes_at,p.closed_at,
 COALESCE((SELECT jsonb_agg(n ORDER BY i) FROM (SELECT i,(SELECT count(*) FROM channel_poll_votes v WHERE v.poll_id=p.id AND v.option_index=i) n FROM generate_series(0,jsonb_array_length(p.options)-1) i) counts),'[]'),
 (SELECT option_index FROM channel_poll_votes WHERE poll_id=p.id AND user_id=$2)
 FROM channel_polls p WHERE p.room_id=$1 AND can_access_room(p.room_id,$2) ORDER BY p.created_at DESC,p.id LIMIT 100`, room, user)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var p ChannelPoll
		var options, counts []byte
		err = rows.Scan(&p.ID, &p.AuthorID, &p.Question, &options, &p.CreatedAt, &p.ClosesAt, &p.ClosedAt, &counts, &p.Vote)
		if err == nil {
			err = json.Unmarshal(options, &p.Options)
		}
		if err == nil {
			err = json.Unmarshal(counts, &p.Counts)
		}
		if err != nil {
			rows.Close()
			return out, err
		}
		out.Polls = append(out.Polls, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = s.DB.Query(ctx, `SELECT e.id::text,e.room_id::text,e.author_id::text,e.title,e.description,e.starts_at,e.cancelled_at,
 (SELECT count(*) FROM channel_event_rsvps WHERE event_id=e.id AND response='going'),(SELECT count(*) FROM channel_event_rsvps WHERE event_id=e.id AND response='maybe'),COALESCE((SELECT response FROM channel_event_rsvps WHERE event_id=e.id AND user_id=$2),'')
 FROM channel_scheduled_events e WHERE e.room_id=$1 AND e.starts_at>clock_timestamp()-interval '7 days' AND can_access_room(e.room_id,$2) ORDER BY e.starts_at,e.id LIMIT 100`, room, user)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var e ScheduledChannelEvent
		if err = rows.Scan(&e.ID, &e.RoomID, &e.AuthorID, &e.Title, &e.Description, &e.StartsAt, &e.CancelledAt, &e.Going, &e.Maybe, &e.Response); err != nil {
			rows.Close()
			return out, err
		}
		out.Events = append(out.Events, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = s.DB.Query(ctx, assetSelect+` WHERE a.room_id=$1 AND can_access_room(a.room_id,$2) AND f.upload_state='ready' AND f.scan_state IN('not_required','clean') AND f.deleted_at IS NULL ORDER BY a.kind,a.created_at,a.id LIMIT 200`, room, user)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		a, e := scanChannelAsset(rows)
		if e != nil {
			rows.Close()
			return out, e
		}
		out.Assets = append(out.Assets, a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	out.Watch, err = s.watchTogether(room, user)
	if errors.Is(err, ErrNotFound) {
		err = nil
	}
	return out, err
}
func (s *PostgresStore) CreateChannelPoll(room, user, question string, options []string, closes *time.Time) error {
	if !validPoll(question, options, closes, time.Now()) {
		return ErrForbidden
	}
	tx, err := s.activityTx(room, user, true, false)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	raw, err := json.Marshal(options)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO channel_polls(room_id,author_id,question,options,closes_at) VALUES($1,$2,$3,$4,$5)`, room, user, question, raw, closes)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) VoteChannelPoll(room, user, id string, option *int) error {
	tx, err := s.activityTx(room, user, false, false)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	var count int
	var closed bool
	err = tx.QueryRow(ctx, `SELECT jsonb_array_length(options),closed_at IS NOT NULL OR COALESCE(closes_at<=clock_timestamp(),false) FROM channel_polls WHERE room_id=$1 AND id=$2 FOR UPDATE`, room, id).Scan(&count, &closed)
	if err != nil {
		return norm(err)
	}
	if closed {
		return ErrConflict
	}
	if option != nil && (*option < 0 || *option >= count) {
		return ErrForbidden
	}
	if option == nil {
		_, err = tx.Exec(ctx, `DELETE FROM channel_poll_votes WHERE poll_id=$1 AND user_id=$2`, id, user)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO channel_poll_votes(poll_id,user_id,option_index) VALUES($1,$2,$3) ON CONFLICT(poll_id,user_id) DO UPDATE SET option_index=EXCLUDED.option_index,updated_at=clock_timestamp()`, id, user, *option)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) CloseChannelPoll(room, user, id string) error {
	tx, err := s.activityTx(room, user, true, false)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	var result string
	err = tx.QueryRow(ctx, `UPDATE channel_polls SET closed_at=COALESCE(closed_at,clock_timestamp()) WHERE room_id=$1 AND id=$3 AND (author_id=$2 OR room_has_permission($1,$2,'moderate')) RETURNING id::text`, room, user, id).Scan(&result)
	if err != nil {
		return norm(err)
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) CreateScheduledEvent(room, user, title, description string, starts time.Time) error {
	if !activityText(title, 1, 120) || !activityText(description, 0, 1000) || !starts.After(time.Now()) || starts.After(time.Now().Add(366*24*time.Hour)) {
		return ErrForbidden
	}
	tx, err := s.activityTx(room, user, true, false)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO channel_scheduled_events(room_id,author_id,title,description,starts_at) VALUES($1,$2,$3,$4,$5) RETURNING id::text`, room, user, title, description, starts).Scan(&id)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO channel_event_rsvps(event_id,user_id,response) VALUES($1,$2,'going')`, id, user)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) RSVPScheduledEvent(room, user, id, response string) error {
	if response != "going" && response != "maybe" && response != "declined" {
		return ErrForbidden
	}
	tx, err := s.activityTx(room, user, false, false)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	var cancelled bool
	err = tx.QueryRow(ctx, `SELECT cancelled_at IS NOT NULL OR starts_at<clock_timestamp()-interval '1 day' FROM channel_scheduled_events WHERE room_id=$1 AND id=$2 FOR UPDATE`, room, id).Scan(&cancelled)
	if err != nil {
		return norm(err)
	}
	if cancelled {
		return ErrConflict
	}
	_, err = tx.Exec(ctx, `INSERT INTO channel_event_rsvps(event_id,user_id,response) VALUES($1,$2,$3) ON CONFLICT(event_id,user_id) DO UPDATE SET response=EXCLUDED.response`, id, user, response)
	if err != nil {
		return err
	}
	if response == "declined" {
		_, err = tx.Exec(ctx, `UPDATE channel_event_reminders SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp()) WHERE event_id=$1 AND user_id=$2`, id, user)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) CancelScheduledEvent(room, user, id string) error {
	tx, err := s.activityTx(room, user, true, false)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	var found string
	err = tx.QueryRow(ctx, `UPDATE channel_scheduled_events SET cancelled_at=COALESCE(cancelled_at,clock_timestamp()) WHERE room_id=$1 AND id=$3 AND (author_id=$2 OR room_has_permission($1,$2,'moderate')) RETURNING id::text`, room, user, id).Scan(&found)
	if err != nil {
		return norm(err)
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) EventReminders(user string) ([]ChannelEventReminder, error) {
	ctx := context.Background()
	_, err := s.DB.Exec(ctx, `INSERT INTO channel_event_reminders(event_id,user_id)
 SELECT e.id,$1 FROM channel_scheduled_events e JOIN channel_event_rsvps r ON r.event_id=e.id AND r.user_id=$1
 WHERE e.cancelled_at IS NULL AND r.response IN('going','maybe') AND e.starts_at<=clock_timestamp()+interval '10 minutes' AND e.starts_at>clock_timestamp()-interval '1 day' AND can_access_room(e.room_id,$1)
 ON CONFLICT(event_id,user_id) DO NOTHING`, user)
	if err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(ctx, `SELECT n.id::text,e.id::text,e.room_id::text,r.name,e.title,e.starts_at,n.created_at FROM channel_event_reminders n JOIN channel_scheduled_events e ON e.id=n.event_id JOIN rooms r ON r.id=e.room_id JOIN channel_event_rsvps v ON v.event_id=e.id AND v.user_id=n.user_id WHERE n.user_id=$1 AND n.acknowledged_at IS NULL AND e.cancelled_at IS NULL AND v.response IN('going','maybe') AND can_access_room(e.room_id,$1) ORDER BY e.starts_at,n.id LIMIT 100`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChannelEventReminder{}
	for rows.Next() {
		var v ChannelEventReminder
		if err = rows.Scan(&v.ID, &v.EventID, &v.RoomID, &v.RoomName, &v.Title, &v.StartsAt, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *PostgresStore) AcknowledgeEventReminder(user, id string) error {
	_, err := s.DB.Exec(context.Background(), `UPDATE channel_event_reminders SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp()) WHERE id=$1 AND user_id=$2`, id, user)
	return err
}

const assetSelect = `SELECT a.id::text,a.name,a.kind,a.creator_id::text,a.duration_ms,f.id::text,f.filename,f.content_type,f.size_bytes,f.voice_note,f.duration_ms FROM channel_media_assets a JOIN message_attachments f ON f.id=a.attachment_id`

func scanChannelAsset(row pgx.Row) (ChannelMediaAsset, error) {
	var a ChannelMediaAsset
	err := row.Scan(&a.ID, &a.Name, &a.Kind, &a.CreatorID, &a.DurationMS, &a.Attachment.ID, &a.Attachment.Filename, &a.Attachment.ContentType, &a.Attachment.SizeBytes, &a.Attachment.VoiceNote, &a.Attachment.DurationMS)
	return a, norm(err)
}
func (s *PostgresStore) ChannelMediaAsset(room, user, id string) (ChannelMediaAsset, error) {
	return scanChannelAsset(s.DB.QueryRow(context.Background(), assetSelect+` WHERE a.room_id=$1 AND a.id=$3 AND can_access_room(a.room_id,$2) AND f.upload_state='ready' AND f.scan_state IN('not_required','clean') AND f.deleted_at IS NULL`, room, user, id))
}
func (s *PostgresStore) CreateChannelMediaAsset(room, user, attachment, name, kind string, duration *int) error {
	if !activityText(name, 1, 60) || (kind != "sticker" && kind != "sound") || kind == "sound" && (duration == nil || *duration < 1 || *duration > 30000) {
		return ErrForbidden
	}
	tx, err := s.activityTx(room, user, true, false)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	var mime string
	var size int64
	err = tx.QueryRow(ctx, `SELECT content_type,size_bytes FROM message_attachments WHERE id=$1 AND room_id=$2 AND uploader_id=$3 AND message_id IS NULL AND upload_state='ready' AND scan_state IN('not_required','clean') AND deleted_at IS NULL AND created_at>clock_timestamp()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM channel_media_assets WHERE attachment_id=$1) FOR UPDATE`, attachment, room, user).Scan(&mime, &size)
	if err != nil {
		return norm(err)
	}
	if kind == "sticker" && (!strings.HasPrefix(mime, "image/") || mime == "image/svg+xml" || size > 5<<20) || kind == "sound" && (!strings.HasPrefix(mime, "audio/") || size > 2<<20) {
		return ErrForbidden
	}
	var count int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM channel_media_assets WHERE room_id=$1 AND kind=$2`, room, kind).Scan(&count)
	if err != nil {
		return err
	}
	if count >= 100 {
		return ErrConflict
	}
	_, err = tx.Exec(ctx, `INSERT INTO channel_media_assets(room_id,attachment_id,creator_id,name,kind,duration_ms) VALUES($1,$2,$3,$4,$5,$6)`, room, attachment, user, name, kind, duration)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) DeleteChannelMediaAsset(room, user, id string) error {
	tx, err := s.activityTx(room, user, true, false)
	if err != nil {
		return err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	var attachment string
	err = tx.QueryRow(ctx, `DELETE FROM channel_media_assets WHERE room_id=$1 AND id=$3 AND (creator_id=$2 OR room_has_permission($1,$2,'moderate')) RETURNING attachment_id::text`, room, user, id).Scan(&attachment)
	if err != nil {
		return norm(err)
	}
	_, err = tx.Exec(ctx, `UPDATE message_attachments SET deleted_at=clock_timestamp() WHERE id=$1 AND message_id IS NULL`, attachment)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) SendStickerMessage(room, user, id, nonce string) (Message, bool, error) {
	ctx := context.Background()
	tx, err := s.activityTx(room, user, true, false)
	if err != nil {
		return Message{}, false, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))`, room); err != nil {
		return Message{}, false, err
	}
	var existing, existingAsset string
	err = tx.QueryRow(ctx, `SELECT m.id::text,COALESCE(l.asset_id::text,'') FROM messages m LEFT JOIN message_asset_links l ON l.message_id=m.id WHERE m.room_id=$1 AND m.author_id=$2 AND m.client_nonce=$3`, room, user, nonce).Scan(&existing, &existingAsset)
	if err == nil {
		if existingAsset != id {
			return Message{}, false, ErrConflict
		}
		m, e := scanMessage(tx.QueryRow(ctx, messageSelect+` WHERE m.room_id=$1 AND m.id=$2`, room, existing))
		return m, false, e
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Message{}, false, err
	}
	if err = checkRoomPosting(ctx, tx, room, user, true); err != nil {
		return Message{}, false, err
	}
	var name string
	err = tx.QueryRow(ctx, `SELECT a.name FROM channel_media_assets a JOIN message_attachments f ON f.id=a.attachment_id WHERE a.room_id=$1 AND a.id=$2 AND a.kind='sticker' AND f.upload_state='ready' AND f.scan_state IN('not_required','clean') AND f.deleted_at IS NULL FOR SHARE OF a,f`, room, id).Scan(&name)
	if err != nil {
		return Message{}, false, norm(err)
	}
	var message string
	err = tx.QueryRow(ctx, `INSERT INTO messages(room_id,author_id,body,client_nonce) VALUES($1,$2,$3,$4) RETURNING id::text`, room, user, "Sticker: "+name, nonce).Scan(&message)
	if err != nil {
		return Message{}, false, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO message_asset_links(message_id,asset_id) VALUES($1,$2)`, message, id); err != nil {
		return Message{}, false, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO push_deliveries(message_id,subscription_id) SELECT $1,ps.id FROM room_members rm JOIN push_subscriptions ps ON ps.user_id=rm.user_id WHERE rm.room_id=$2 AND rm.user_id<>$3 AND NOT ps.dnd AND EXISTS(SELECT 1 FROM users recipient WHERE recipient.id=rm.user_id AND recipient.presence_status<>'dnd') ON CONFLICT DO NOTHING`, message, room, user)
	if err != nil {
		return Message{}, false, err
	}
	m, err := scanMessage(tx.QueryRow(ctx, messageSelect+` WHERE m.room_id=$1 AND m.id=$2`, room, message))
	if err != nil {
		return Message{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Message{}, false, err
	}
	return m, true, nil
}
func (s *PostgresStore) MessageEditHistory(room, user, id string) ([]MessageEditVersion, error) {
	ctx := context.Background()
	var found string
	err := s.DB.QueryRow(ctx, `SELECT id::text FROM messages WHERE room_id=$1 AND id=$3 AND deleted_at IS NULL AND can_access_room(room_id,$2)`, room, user, id).Scan(&found)
	if err != nil {
		return nil, norm(err)
	}
	rows, err := s.DB.Query(ctx, `SELECT h.version,h.body,h.changed_at FROM message_edit_history h JOIN messages m ON m.id=h.message_id WHERE m.room_id=$1 AND h.message_id=$3 AND m.deleted_at IS NULL AND can_access_room(m.room_id,$2) ORDER BY h.version DESC LIMIT 100`, room, user, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MessageEditVersion{}
	for rows.Next() {
		var v MessageEditVersion
		if err = rows.Scan(&v.Version, &v.Body, &v.ChangedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

const watchSelect = `SELECT w.room_id::text,a.id::text,a.filename,a.content_type,a.size_bytes,w.host_id::text,w.paused,w.position_seconds,w.revision,w.updated_at,clock_timestamp(),(w.host_id IS NULL OR NOT room_has_permission(w.room_id,w.host_id,'join_voice') OR NOT room_has_permission(w.room_id,w.host_id,'post') OR w.host_seen_at<clock_timestamp()-interval '60 seconds') FROM channel_watch_sessions w JOIN message_attachments a ON a.id=w.attachment_id JOIN messages m ON m.id=a.message_id`

func scanWatch(row pgx.Row) (*WatchTogetherState, error) {
	v := &WatchTogetherState{}
	err := row.Scan(&v.RoomID, &v.Attachment.ID, &v.Attachment.Filename, &v.Attachment.ContentType, &v.Attachment.SizeBytes, &v.HostID, &v.Paused, &v.PositionSeconds, &v.Revision, &v.UpdatedAt, &v.ServerTime, &v.CanClaim)
	if err != nil {
		return nil, norm(err)
	}
	return v, nil
}
func (s *PostgresStore) watchTogether(room, user string) (*WatchTogetherState, error) {
	return scanWatch(s.DB.QueryRow(context.Background(), watchSelect+` WHERE w.room_id=$1 AND room_has_permission(w.room_id,$2,'join_voice') AND a.upload_state='ready' AND a.scan_state IN('not_required','clean') AND a.deleted_at IS NULL AND m.deleted_at IS NULL`, room, user))
}
func (s *PostgresStore) ChangeWatchTogether(room, user string, in WatchTogetherCommand) (*WatchTogetherState, error) {
	if !validWatchCommand(in) {
		return nil, ErrForbidden
	}
	tx, err := s.activityTx(room, user, true, true)
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,5))`, room); err != nil {
		return nil, err
	}
	var host *string
	var revision int64
	var claim bool
	err = tx.QueryRow(ctx, `SELECT host_id::text,revision,(host_id IS NULL OR NOT room_has_permission(room_id,host_id,'join_voice') OR NOT room_has_permission(room_id,host_id,'post') OR host_seen_at<clock_timestamp()-interval '60 seconds') FROM channel_watch_sessions WHERE room_id=$1 FOR UPDATE`, room).Scan(&host, &revision, &claim)
	if errors.Is(err, pgx.ErrNoRows) {
		if in.Action != "start" {
			return nil, ErrNotFound
		}
	} else if err != nil {
		return nil, err
	} else {
		if in.Revision != revision {
			return nil, ErrConflict
		}
		owns := host != nil && *host == user
		if in.Action == "claim" {
			if !claim && !owns {
				return nil, ErrForbidden
			}
		} else if !owns {
			return nil, ErrForbidden
		}
	}
	switch in.Action {
	case "start":
		var found string
		err = tx.QueryRow(ctx, `SELECT a.id::text FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.room_id=$1 AND a.id=$2 AND a.upload_state='ready' AND a.scan_state IN('not_required','clean') AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND a.content_type LIKE 'video/%' FOR SHARE OF a,m`, room, in.AttachmentID).Scan(&found)
		if err != nil {
			return nil, norm(err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO channel_watch_sessions(room_id,attachment_id,host_id) VALUES($1,$2,$3) ON CONFLICT(room_id) DO UPDATE SET attachment_id=EXCLUDED.attachment_id,host_id=EXCLUDED.host_id,paused=true,position_seconds=0,revision=channel_watch_sessions.revision+1,updated_at=clock_timestamp(),host_seen_at=clock_timestamp()`, room, in.AttachmentID, user)
	case "stop":
		_, err = tx.Exec(ctx, `DELETE FROM channel_watch_sessions WHERE room_id=$1`, room)
	case "heartbeat":
		_, err = tx.Exec(ctx, `UPDATE channel_watch_sessions SET host_seen_at=clock_timestamp() WHERE room_id=$1`, room)
	case "claim":
		_, err = tx.Exec(ctx, `UPDATE channel_watch_sessions SET host_id=$2,revision=revision+1,host_seen_at=clock_timestamp() WHERE room_id=$1`, room, user)
	case "transfer":
		var allowed bool
		err = tx.QueryRow(ctx, `SELECT room_has_permission($1,$2,'post') AND room_has_permission($1,$2,'join_voice')`, room, in.HostID).Scan(&allowed)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, ErrForbidden
		}
		_, err = tx.Exec(ctx, `UPDATE channel_watch_sessions SET host_id=$2,revision=revision+1,host_seen_at=clock_timestamp() WHERE room_id=$1`, room, in.HostID)
	case "play", "pause", "seek":
		_, err = tx.Exec(ctx, `UPDATE channel_watch_sessions SET position_seconds=$2,paused=CASE WHEN $3='play' THEN false WHEN $3='pause' THEN true ELSE paused END,revision=revision+1,updated_at=clock_timestamp(),host_seen_at=clock_timestamp() WHERE room_id=$1`, room, in.PositionSeconds, in.Action)
	}
	if err != nil {
		return nil, err
	}
	var value *WatchTogetherState
	if in.Action != "stop" {
		value, err = scanWatch(tx.QueryRow(ctx, watchSelect+` WHERE w.room_id=$1 AND a.deleted_at IS NULL AND m.deleted_at IS NULL`, room))
		if err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return value, nil
}
