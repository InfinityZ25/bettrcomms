package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func draftMutationHash(body, reply string) string {
	v := sha256.Sum256([]byte(body + "\x00" + strings.ToLower(reply)))
	return hex.EncodeToString(v[:])
}
func draftScope(root string) string {
	if root == "" {
		return emptyDraftScope
	}
	return strings.ToLower(root)
}

const draftSelect = `SELECT d.room_id::text,d.thread_root_id::text,d.body,CASE WHEN quoted.deleted_at IS NULL THEN d.reply_to_id::text END,d.version,d.mutation_id::text,d.updated_at FROM account_text_drafts d LEFT JOIN messages quoted ON quoted.id=d.reply_to_id`

func scanTextDraft(row pgx.Row) (TextDraft, error) {
	var d TextDraft
	e := row.Scan(&d.RoomID, &d.ThreadRootID, &d.Body, &d.ReplyToID, &d.Version, &d.MutationID, &d.UpdatedAt)
	return d, norm(e)
}

func (s *PostgresStore) DraftSettings(ctx context.Context, user string) (DraftSyncSettings, error) {
	var out DraftSyncSettings
	e := s.DB.QueryRow(ctx, `SELECT COALESCE(p.enabled,true),COALESCE(p.version,0) FROM users u LEFT JOIN account_draft_settings p ON p.user_id=u.id WHERE u.id=$1 AND u.deleted_at IS NULL`, user).Scan(&out.Enabled, &out.Version)
	return out, norm(e)
}
func (s *PostgresStore) SetDraftSettings(ctx context.Context, user string, enabled bool, version int64) (DraftSyncSettings, error) {
	out := DraftSyncSettings{Enabled: true}
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	var id string
	if e = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, user).Scan(&id); e != nil {
		return out, norm(e)
	}
	e = tx.QueryRow(ctx, `SELECT enabled,version FROM account_draft_settings WHERE user_id=$1`, user).Scan(&out.Enabled, &out.Version)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	if out.Version != version {
		return out, ErrConflict
	}
	out.Enabled = enabled
	out.Version++
	_, e = tx.Exec(ctx, `INSERT INTO account_draft_settings(user_id,enabled,version) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,version=EXCLUDED.version`, user, enabled, out.Version)
	if e != nil {
		return out, e
	}
	return out, tx.Commit(ctx)
}
func validateDraftScope(ctx context.Context, tx pgx.Tx, room, root, reply string) error {
	if root != "" {
		var found string
		e := tx.QueryRow(ctx, `SELECT id::text FROM messages WHERE id=$1 AND room_id=$2 AND thread_root_id IS NULL AND (deleted_at IS NULL OR EXISTS(SELECT 1 FROM messages child WHERE child.thread_root_id=messages.id)) FOR SHARE`, root, room).Scan(&found)
		if e != nil {
			return norm(e)
		}
	}
	if reply != "" {
		var found string
		e := tx.QueryRow(ctx, `SELECT id::text FROM messages WHERE id=$1 AND room_id=$2 AND deleted_at IS NULL AND (COALESCE(thread_root_id::text,'')=$3 OR id::text=$3) FOR SHARE`, reply, room, root).Scan(&found)
		if e != nil {
			return norm(e)
		}
	}
	return nil
}
func (s *PostgresStore) TextDraft(ctx context.Context, user, room, root string) (TextDraft, error) {
	out := TextDraft{RoomID: room}
	if root != "" {
		out.ThreadRootID = &root
	}
	tx, e := s.personalTx(ctx, user, room)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	if e = validateDraftScope(ctx, tx, room, root, ""); e != nil {
		return out, e
	}
	v, e := scanTextDraft(tx.QueryRow(ctx, draftSelect+` WHERE d.user_id=$1 AND d.room_id=$2 AND d.scope_id=$3`, user, room, draftScope(root)))
	if errors.Is(e, ErrNotFound) {
		e = nil
	} else if e == nil {
		out = v
	}
	if e != nil {
		return out, e
	}
	return out, tx.Commit(ctx)
}
func (s *PostgresStore) PutTextDraft(ctx context.Context, user, room, root string, in TextDraftInput) (TextDraft, error) {
	out := TextDraft{RoomID: room}
	if root != "" {
		out.ThreadRootID = &root
	}
	if !validDraftInput(in) {
		return out, ErrForbidden
	}
	root = strings.ToLower(root)
	in.ReplyToID = strings.ToLower(in.ReplyToID)
	in.MutationID = strings.ToLower(in.MutationID)
	tx, e := s.personalTx(ctx, user, room)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	var enabled bool
	if e = tx.QueryRow(ctx, `SELECT COALESCE((SELECT enabled FROM account_draft_settings WHERE user_id=$1),true)`, user).Scan(&enabled); e != nil {
		return out, e
	}
	if !enabled {
		return out, ErrDraftSyncDisabled
	}
	if e = validateDraftScope(ctx, tx, room, root, in.ReplyToID); e != nil {
		return out, e
	}
	var previousHash string
	e = tx.QueryRow(ctx, `SELECT room_id::text,thread_root_id::text,body,reply_to_id::text,version,mutation_id::text,updated_at,mutation_hash FROM account_text_drafts WHERE user_id=$1 AND room_id=$2 AND scope_id=$3 FOR UPDATE`, user, room, draftScope(root)).Scan(&out.RoomID, &out.ThreadRootID, &out.Body, &out.ReplyToID, &out.Version, &out.MutationID, &out.UpdatedAt, &previousHash)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	hash := draftMutationHash(in.Body, in.ReplyToID)
	if out.MutationID != nil && *out.MutationID == in.MutationID {
		if hash != previousHash {
			return out, ErrConflict
		}
		return out, tx.Commit(ctx)
	}
	if out.Version != in.ExpectedVersion {
		return out, ErrConflict
	}
	// Empty rows are versioned tombstones: offline writers must not recreate sent text.
	_, e = tx.Exec(ctx, `INSERT INTO account_text_drafts(user_id,room_id,thread_root_id,body,reply_to_id,version,mutation_id,mutation_hash) VALUES($1,$2,NULLIF($3,'')::uuid,$4,NULLIF($5,'')::uuid,$6,$7,$8) ON CONFLICT(user_id,room_id,scope_id) DO UPDATE SET body=EXCLUDED.body,reply_to_id=EXCLUDED.reply_to_id,version=EXCLUDED.version,mutation_id=EXCLUDED.mutation_id,mutation_hash=EXCLUDED.mutation_hash,updated_at=clock_timestamp()`, user, room, root, in.Body, in.ReplyToID, out.Version+1, in.MutationID, hash)
	if e != nil {
		return out, e
	}
	out, e = scanTextDraft(tx.QueryRow(ctx, draftSelect+` WHERE d.user_id=$1 AND d.room_id=$2 AND d.scope_id=$3`, user, room, draftScope(root)))
	if e != nil {
		return out, e
	}
	return out, tx.Commit(ctx)
}
func (s *PostgresStore) TextDrafts(ctx context.Context, user, cursor string, limit int) (TextDraftPage, error) {
	out := TextDraftPage{Drafts: []TextDraft{}}
	c, e := readPersonalCursor(cursor)
	if e != nil {
		return out, e
	}
	limit = boundedPersonalLimit(limit)
	var at *time.Time
	if !c.At.IsZero() {
		at = &c.At
	}
	if c.Root == "" {
		c.Root = emptyDraftScope
	}
	rows, e := s.DB.Query(ctx, draftSelect+` JOIN users owner ON owner.id=d.user_id AND owner.deleted_at IS NULL WHERE d.user_id=$1 AND can_access_room(d.room_id,$1) AND (d.thread_root_id IS NULL OR EXISTS(SELECT 1 FROM messages root WHERE root.id=d.thread_root_id AND root.room_id=d.room_id AND root.thread_root_id IS NULL AND (root.deleted_at IS NULL OR EXISTS(SELECT 1 FROM messages child WHERE child.thread_root_id=root.id)))) AND ($2::timestamptz IS NULL OR (d.updated_at,d.room_id,d.scope_id)<($2,NULLIF($3,'')::uuid,$4::uuid)) ORDER BY d.updated_at DESC,d.room_id DESC,d.scope_id DESC LIMIT $5`, user, at, c.ID, c.Root, limit+1)
	if e != nil {
		return out, e
	}
	defer rows.Close()
	for rows.Next() {
		d, e := scanTextDraft(rows)
		if e != nil {
			return out, e
		}
		out.Drafts = append(out.Drafts, d)
	}
	if e = rows.Err(); e != nil {
		return out, e
	}
	if len(out.Drafts) > limit {
		out.Drafts = out.Drafts[:limit]
		last := out.Drafts[limit-1]
		root := ""
		if last.ThreadRootID != nil {
			root = *last.ThreadRootID
		}
		out.NextCursor = writePersonalCursor(*last.UpdatedAt, last.RoomID, draftScope(root))
	}
	return out, nil
}

type DraftSendClear struct {
	Version    int64
	MutationID string
}

func clearSubmittedDraft(ctx context.Context, tx pgx.Tx, user, room, root string, clear *DraftSendClear) error {
	if clear == nil {
		return nil
	}
	if clear.Version == 0 {
		_, e := tx.Exec(ctx, `INSERT INTO account_text_drafts(user_id,room_id,thread_root_id,body,version,mutation_id,mutation_hash) SELECT $1,$2,NULLIF($3,'')::uuid,'',1,$4,$5 WHERE COALESCE((SELECT enabled FROM account_draft_settings WHERE user_id=$1),true) ON CONFLICT(user_id,room_id,scope_id) DO NOTHING`, user, room, root, clear.MutationID, draftMutationHash("", ""))
		if e != nil {
			return e
		}
	}
	_, e := tx.Exec(ctx, `UPDATE account_text_drafts SET body='',reply_to_id=NULL,version=version+1,mutation_id=$5,mutation_hash=$6,updated_at=clock_timestamp() WHERE user_id=$1 AND room_id=$2 AND scope_id=$3 AND version=$4 AND COALESCE((SELECT enabled FROM account_draft_settings WHERE user_id=$1),true)`, user, room, draftScope(root), clear.Version, clear.MutationID, draftMutationHash("", ""))
	return e
}
func (s *PostgresStore) SendMessageWithDraft(room, user, body, reply, nonce string, attachments []string, root string, clear DraftSendClear) (Message, bool, error) {
	return s.writeMessageWithDraft(room, user, "", body, reply, nonce, attachments, root, &clear)
}
