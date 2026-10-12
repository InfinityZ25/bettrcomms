package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const emptyDraftScope = "00000000-0000-0000-0000-000000000000"

type personalCursor struct {
	At   time.Time `json:"at"`
	ID   string    `json:"id"`
	Root string    `json:"root,omitempty"`
}

func readPersonalCursor(raw string) (personalCursor, error) {
	var c personalCursor
	if raw == "" {
		return c, nil
	}
	if len(raw) > 350 {
		return c, ErrDailyCursor
	}
	b, e := base64.RawURLEncoding.DecodeString(raw)
	if e != nil {
		return c, ErrDailyCursor
	}
	if json.Unmarshal(b, &c) != nil || c.At.IsZero() || !uuidPattern.MatchString(c.ID) || c.Root != "" && !uuidPattern.MatchString(c.Root) {
		return c, ErrDailyCursor
	}
	return c, nil
}
func writePersonalCursor(at time.Time, id, root string) string {
	b, _ := json.Marshal(personalCursor{At: at, ID: id, Root: root})
	return base64.RawURLEncoding.EncodeToString(b)
}
func boundedPersonalLimit(limit int) int {
	if limit < 1 || limit > 100 {
		return 50
	}
	return limit
}

func lockPersonalActor(ctx context.Context, tx pgx.Tx, user string) error {
	var id string
	e := tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR KEY SHARE`, user).Scan(&id)
	return norm(e)
}
func (s *PostgresStore) personalTx(ctx context.Context, user, room string) (pgx.Tx, error) {
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return nil, e
	}
	if e = lockPersonalActor(ctx, tx, user); e == nil {
		e = lockRoomCommunity(ctx, tx, room)
	}
	if e == nil {
		_, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))`, room)
	}
	if e == nil {
		var member string
		e = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 AND can_access_room($1,$2) FOR SHARE`, room, user).Scan(&member)
		if errors.Is(e, pgx.ErrNoRows) {
			e = ErrForbidden
		}
	}
	if e != nil {
		tx.Rollback(ctx)
		return nil, e
	}
	return tx, nil
}
func (s *PostgresStore) personalMessages(ctx context.Context, user string, ids []string) (map[string]*Message, error) {
	out := map[string]*Message{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, e := s.DB.Query(ctx, messageSelect+` WHERE m.id=ANY($1::uuid[]) AND m.deleted_at IS NULL AND can_access_room(m.room_id,$2)`, ids, user)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		m, e := scanMessage(rows)
		if e != nil {
			return nil, e
		}
		out[m.ID] = &m
	}
	return out, rows.Err()
}

const savedSourceSQL = ` FROM personal_saved_items i LEFT JOIN message_attachments a ON a.id=i.attachment_id
 LEFT JOIN messages m ON m.id=COALESCE(i.message_id,a.message_id) JOIN rooms r ON r.id=COALESCE(m.room_id,a.room_id)
 WHERE i.user_id=$1 AND can_access_room(r.id,$1) AND EXISTS(SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL)
 AND ((i.message_id IS NOT NULL AND m.deleted_at IS NULL) OR (i.attachment_id IS NOT NULL AND a.deleted_at IS NULL
  AND a.upload_state='ready' AND a.scan_state IN('not_required','clean') AND EXISTS(SELECT 1 FROM users WHERE id=a.uploader_id AND deleted_at IS NULL)
  AND ((a.message_id IS NOT NULL AND m.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id AND asset.room_id=a.room_id))))`

func (s *PostgresStore) PersonalSavedIndex(ctx context.Context, user string) (map[string][]string, error) {
	out := map[string][]string{"message_ids": {}, "file_ids": {}}
	rows, e := s.DB.Query(ctx, `SELECT i.message_id::text,i.attachment_id::text`+savedSourceSQL+` ORDER BY i.created_at DESC,i.id DESC LIMIT 1000`, user)
	if e != nil {
		return out, e
	}
	defer rows.Close()
	for rows.Next() {
		var m, a *string
		if e = rows.Scan(&m, &a); e != nil {
			return out, e
		}
		if m != nil {
			out["message_ids"] = append(out["message_ids"], *m)
		} else if a != nil {
			out["file_ids"] = append(out["file_ids"], *a)
		}
	}
	return out, rows.Err()
}
func (s *PostgresStore) PersonalSavedItems(ctx context.Context, user, kind, cursor string, limit int) (PersonalSavedPage, error) {
	out := PersonalSavedPage{Items: []PersonalSavedItem{}}
	c, e := readPersonalCursor(cursor)
	if e != nil {
		return out, e
	}
	limit = boundedPersonalLimit(limit)
	var at *time.Time
	if !c.At.IsZero() {
		at = &c.At
	}
	rows, e := s.DB.Query(ctx, `SELECT i.id::text,CASE WHEN i.message_id IS NULL THEN 'file' ELSE 'message' END,r.id::text,r.name,m.id::text,i.created_at,
 CASE WHEN a.id IS NOT NULL THEN jsonb_build_object('id',a.id,'filename',a.filename,'content_type',a.content_type,'size_bytes',a.size_bytes,'voice_note',a.voice_note,'duration_ms',a.duration_ms) END`+savedSourceSQL+
		` AND ($2='all' OR ($2='file' AND i.attachment_id IS NOT NULL) OR ($2='message' AND i.message_id IS NOT NULL) OR ($2='link' AND i.message_id IS NOT NULL AND m.body ~* 'https?://'))
 AND ($3::timestamptz IS NULL OR (i.created_at,i.id)<($3,NULLIF($4,'')::uuid)) ORDER BY i.created_at DESC,i.id DESC LIMIT $5`, user, kind, at, c.ID, limit+1)
	if e != nil {
		return out, e
	}
	mids := []string{}
	itemMessages := []string{}
	for rows.Next() {
		var item PersonalSavedItem
		var mid *string
		var raw []byte
		if e = rows.Scan(&item.ID, &item.Kind, &item.RoomID, &item.RoomName, &mid, &item.CreatedAt, &raw); e != nil {
			break
		}
		if len(raw) > 0 {
			if e = json.Unmarshal(raw, &item.Attachment); e != nil {
				break
			}
		}
		id := ""
		if mid != nil {
			id = *mid
			mids = append(mids, id)
		}
		itemMessages = append(itemMessages, id)
		out.Items = append(out.Items, item)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return out, e
	}
	if len(out.Items) > limit {
		out.Items = out.Items[:limit]
		last := out.Items[limit-1]
		out.NextCursor = writePersonalCursor(last.CreatedAt, last.ID, "")
	}
	messages, e := s.personalMessages(ctx, user, mids)
	if e != nil {
		return out, e
	}
	filtered := out.Items[:0]
	for i, item := range out.Items {
		item.Message = messages[itemMessages[i]]
		if item.Kind == "message" && item.Message == nil {
			continue
		}
		filtered = append(filtered, item)
	}
	out.Items = filtered
	return out, nil
}
func (s *PostgresStore) SetPersonalSavedItem(ctx context.Context, user, kind, source string, save bool) error {
	if (kind != "message" && kind != "file") || !uuidPattern.MatchString(source) {
		return ErrNotFound
	}
	if !save {
		_, e := s.DB.Exec(ctx, `DELETE FROM personal_saved_items WHERE user_id=$1 AND (($2='message' AND message_id=$3) OR ($2='file' AND attachment_id=$3))`, user, kind, source)
		return e
	}
	var room string
	var message *string
	var e error
	if kind == "message" {
		e = s.DB.QueryRow(ctx, `SELECT room_id::text,id::text FROM messages WHERE id=$1 AND deleted_at IS NULL`, source).Scan(&room, &message)
	} else {
		e = s.DB.QueryRow(ctx, `SELECT room_id::text,message_id::text FROM message_attachments WHERE id=$1 AND deleted_at IS NULL`, source).Scan(&room, &message)
	}
	if e != nil {
		return norm(e)
	}
	tx, e := s.personalTx(ctx, user, room)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if message != nil {
		var found string
		if e = tx.QueryRow(ctx, `SELECT id::text FROM messages WHERE id=$1 AND room_id=$2 AND deleted_at IS NULL FOR SHARE`, *message, room).Scan(&found); e != nil {
			return norm(e)
		}
	}
	if kind == "file" {
		var found string
		e = tx.QueryRow(ctx, `SELECT a.id::text FROM message_attachments a WHERE a.id=$1 AND a.room_id=$2 AND a.deleted_at IS NULL AND a.upload_state='ready' AND a.scan_state IN('not_required','clean') AND EXISTS(SELECT 1 FROM users WHERE id=a.uploader_id AND deleted_at IS NULL) AND (a.message_id IS NOT NULL OR EXISTS(SELECT 1 FROM channel_media_assets asset WHERE asset.attachment_id=a.id)) FOR SHARE`, source, room).Scan(&found)
		if e != nil {
			return norm(e)
		}
	}
	// Serialize the account cap across independent source rooms.
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,12))`, user); e != nil {
		return e
	}
	var exists bool
	var count int
	e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM personal_saved_items WHERE user_id=$1 AND (($2='message' AND message_id=$3) OR ($2='file' AND attachment_id=$3))),(SELECT count(*) FROM personal_saved_items WHERE user_id=$1)`, user, kind, source).Scan(&exists, &count)
	if e != nil {
		return e
	}
	if !exists {
		if count >= 1000 {
			return ErrPersonalLimit
		}
		_, e = tx.Exec(ctx, `INSERT INTO personal_saved_items(user_id,message_id,attachment_id) VALUES($1,CASE WHEN $2='message' THEN $3::uuid END,CASE WHEN $2='file' THEN $3::uuid END)`, user, kind, source)
		if e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) SetPersonalReminder(ctx context.Context, user, room, message string, due time.Time, mutation string) (PersonalReminder, error) {
	var out PersonalReminder
	due = due.UTC().Truncate(time.Microsecond)
	mutation = strings.ToLower(mutation)
	tx, e := s.personalTx(ctx, user, room)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	var id string
	if e = tx.QueryRow(ctx, `SELECT id::text FROM messages WHERE id=$1 AND room_id=$2 AND deleted_at IS NULL FOR SHARE`, message, room).Scan(&id); e != nil {
		return out, norm(e)
	}
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,12))`, user); e != nil {
		return out, e
	}
	var receiptMessage string
	var receiptDue time.Time
	var receiptReminder *string
	receiptErr := tx.QueryRow(ctx, `SELECT message_id::text,due_at,reminder_id::text FROM personal_reminder_mutations WHERE user_id=$1 AND mutation_id=$2`, user, mutation).Scan(&receiptMessage, &receiptDue, &receiptReminder)
	if receiptErr != nil && !errors.Is(receiptErr, pgx.ErrNoRows) {
		return out, receiptErr
	}
	if receiptErr == nil && (receiptMessage != message || !receiptDue.Equal(due) || receiptReminder == nil) {
		return out, ErrConflict
	}
	var oldMutation string
	var oldDue time.Time
	e = tx.QueryRow(ctx, `SELECT id::text,mutation_id::text,due_at FROM personal_message_reminders WHERE user_id=$1 AND message_id=$2 FOR UPDATE`, user, message).Scan(&id, &oldMutation, &oldDue)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	previousExists := e == nil
	if receiptErr == nil {
		if e != nil || id != *receiptReminder {
			return out, ErrConflict
		}
	} else if e == nil && strings.EqualFold(oldMutation, mutation) {
		if !oldDue.Equal(due) {
			return out, ErrConflict
		}
	} else {
		if !due.After(time.Now()) || due.After(time.Now().Add(366*24*time.Hour)) {
			return out, ErrReminderTime
		}
		if errors.Is(e, pgx.ErrNoRows) {
			var count int
			if e = tx.QueryRow(ctx, `SELECT count(*) FROM personal_message_reminders WHERE user_id=$1`, user).Scan(&count); e != nil {
				return out, e
			}
			if count >= 1000 {
				return out, ErrPersonalLimit
			}
		}
		if previousExists {
			if _, e = tx.Exec(ctx, `DELETE FROM reminder_attention WHERE personal_id=$1`, id); e != nil {
				return out, e
			}
		}
		e = tx.QueryRow(ctx, `INSERT INTO personal_message_reminders(user_id,message_id,due_at,mutation_id) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,message_id) DO UPDATE SET due_at=EXCLUDED.due_at,state='pending',version=personal_message_reminders.version+1,mutation_id=EXCLUDED.mutation_id RETURNING id::text`, user, message, due, mutation).Scan(&id)
		if e != nil {
			return out, e
		}
	}
	if receiptErr != nil {
		if _, e = tx.Exec(ctx, `INSERT INTO personal_reminder_mutations(user_id,mutation_id,message_id,due_at,reminder_id) VALUES($1,$2,$3,$4,$5)`, user, mutation, message, due, id); e != nil {
			return out, e
		}
	}
	if e = tx.QueryRow(ctx, `SELECT p.id::text,m.room_id::text,r.name,p.due_at,p.created_at,p.state,p.version FROM personal_message_reminders p JOIN messages m ON m.id=p.message_id JOIN rooms r ON r.id=m.room_id WHERE p.id=$1`, id).Scan(&out.ID, &out.RoomID, &out.RoomName, &out.DueAt, &out.CreatedAt, &out.State, &out.Version); e != nil {
		return out, e
	}
	m, e := scanMessage(tx.QueryRow(ctx, messageSelect+` WHERE m.id=$1`, message))
	if e != nil {
		return out, e
	}
	out.Message = &m
	return out, tx.Commit(ctx)
}
func (s *PostgresStore) RemovePersonalReminder(ctx context.Context, user, id, room, message string) error {
	_, e := s.DB.Exec(ctx, `DELETE FROM personal_message_reminders p USING messages m WHERE p.user_id=$1 AND m.id=p.message_id AND (($2<>'' AND p.id=NULLIF($2,'')::uuid) OR ($2='' AND m.room_id=NULLIF($3,'')::uuid AND m.id=NULLIF($4,'')::uuid))`, user, id, room, message)
	return e
}
func (s *PostgresStore) PersonalReminders(ctx context.Context, user, state, cursor string, limit int) (PersonalReminderPage, error) {
	out := PersonalReminderPage{Reminders: []PersonalReminder{}}
	c, e := readPersonalCursor(cursor)
	if e != nil {
		return out, e
	}
	limit = boundedPersonalLimit(limit)
	var at *time.Time
	if !c.At.IsZero() {
		at = &c.At
	}
	rows, e := s.DB.Query(ctx, `SELECT p.id::text,m.room_id::text,r.name,m.id::text,p.due_at,p.created_at,p.state,p.version FROM personal_message_reminders p JOIN messages m ON m.id=p.message_id JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=p.user_id AND u.deleted_at IS NULL WHERE p.user_id=$1 AND m.deleted_at IS NULL AND can_access_room(m.room_id,$1) AND ($2='active' OR p.state=$2) AND ($3::timestamptz IS NULL OR (p.due_at,p.id)>($3,NULLIF($4,'')::uuid)) ORDER BY p.due_at,p.id LIMIT $5`, user, state, at, c.ID, limit+1)
	if e != nil {
		return out, e
	}
	ids := []string{}
	for rows.Next() {
		var v PersonalReminder
		var id string
		if e = rows.Scan(&v.ID, &v.RoomID, &v.RoomName, &id, &v.DueAt, &v.CreatedAt, &v.State, &v.Version); e != nil {
			break
		}
		ids = append(ids, id)
		out.Reminders = append(out.Reminders, v)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return out, e
	}
	if len(out.Reminders) > limit {
		out.Reminders = out.Reminders[:limit]
		last := out.Reminders[limit-1]
		out.NextCursor = writePersonalCursor(last.DueAt, last.ID, "")
	}
	messages, e := s.personalMessages(ctx, user, ids)
	if e != nil {
		return out, e
	}
	filtered := out.Reminders[:0]
	for i, v := range out.Reminders {
		v.Message = messages[ids[i]]
		if v.Message != nil {
			filtered = append(filtered, v)
		}
	}
	out.Reminders = filtered
	return out, nil
}
