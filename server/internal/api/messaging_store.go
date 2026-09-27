package api

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Kept separate from the legacy store contract so older API clients and test
// stores can retain the original plain-text routes during the rollout.
type MessagingStore interface {
	MessagePage(room, user, beforeID string, limit int) (MessagePage, error)
	MessageByID(room, id string) (Message, error)
	WriteMessage(room, user, id, body, replyID string) (Message, error)
	DeleteMessage(room, user, id string) (Message, error)
	ReactMessage(room, user, id, emoji string, remove bool) (Message, error)
	SearchMessages(user, room, author, query, beforeID string, limit int) (MessagePage, error)
	UnreadRooms(user string) ([]RoomUnread, error)
	ReadRoom(room, user, messageID string) error
}

var mentionPattern = regexp.MustCompile(`<@([0-9a-fA-F-]{36})>`)
var reactionChoices = map[string]bool{"👍": true, "❤️": true, "😂": true, "🎉": true, "😮": true, "😢": true, "👀": true, "✅": true}

const messageSelect = `SELECT m.id::text,m.room_id::text,m.body,m.created_at,m.sequence,m.version,m.edited_at,m.deleted_at,
 u.id::text,u.email,u.name,u.avatar_url,u.created_at,
 CASE WHEN parent.id IS NOT NULL THEN jsonb_build_object('id',parent.id,'name',pu.name,'body',left(parent.body,400),'deleted',parent.deleted_at IS NOT NULL) END,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',mu.id,'name',mu.name) ORDER BY mu.id) FROM message_mentions mm JOIN users mu ON mu.id=mm.user_id WHERE mm.message_id=m.id),'[]'),
 COALESCE((SELECT jsonb_agg(jsonb_build_object('emoji',r.emoji,'users',r.users) ORDER BY r.emoji) FROM (SELECT emoji,jsonb_agg(user_id::text ORDER BY user_id) users FROM message_reactions WHERE message_id=m.id GROUP BY emoji) r),'[]')
 FROM messages m JOIN users u ON u.id=m.author_id LEFT JOIN messages parent ON parent.id=m.reply_to_id LEFT JOIN users pu ON pu.id=parent.author_id `

func scanMessage(row pgx.Row) (Message, error) {
	var m Message
	var reply, mentions, reactions []byte
	err := row.Scan(&m.ID, &m.RoomID, &m.Body, &m.CreatedAt, &m.Sequence, &m.Version, &m.EditedAt, &m.DeletedAt,
		&m.Author.ID, &m.Author.Email, &m.Author.Name, &m.Author.AvatarURL, &m.Author.CreatedAt, &reply, &mentions, &reactions)
	if err != nil {
		return m, norm(err)
	}
	if len(reply) > 0 {
		if err = json.Unmarshal(reply, &m.Reply); err != nil {
			return m, err
		}
	}
	if err = json.Unmarshal(mentions, &m.Mentions); err != nil {
		return m, err
	}
	err = json.Unmarshal(reactions, &m.Reactions)
	return m, err
}

func (s *PostgresStore) MessageByID(room, id string) (Message, error) {
	return scanMessage(s.DB.QueryRow(context.Background(), messageSelect+` WHERE m.room_id=$1 AND m.id=$2`, room, id))
}

func messageRows(rows pgx.Rows, limit int) (MessagePage, error) {
	defer rows.Close()
	out := MessagePage{Messages: []Message{}}
	for rows.Next() {
		m, e := scanMessage(rows)
		if e != nil {
			return out, e
		}
		out.Messages = append(out.Messages, m)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(out.Messages) > limit {
		out.Messages = out.Messages[:limit]
		out.BeforeID = out.Messages[len(out.Messages)-1].ID
	}
	return out, nil
}
func (s *PostgresStore) MessagePage(room, user, beforeID string, limit int) (MessagePage, error) {
	var before int64 = 9223372036854775807
	if beforeID != "" {
		if !uuidPattern.MatchString(beforeID) {
			return MessagePage{}, ErrNotFound
		}
		err := s.DB.QueryRow(context.Background(), `SELECT sequence FROM messages WHERE room_id=$1 AND id=$2`, room, beforeID).Scan(&before)
		if err != nil {
			return MessagePage{}, norm(err)
		}
	}
	rows, err := s.DB.Query(context.Background(), messageSelect+` WHERE m.room_id=$1 AND m.sequence<$2 AND EXISTS(SELECT 1 FROM room_members WHERE room_id=m.room_id AND user_id=$3) ORDER BY m.sequence DESC LIMIT $4`, room, before, user, limit+1)
	if err != nil {
		return MessagePage{}, err
	}
	page, err := messageRows(rows, limit)
	for i, j := 0, len(page.Messages)-1; i < j; i, j = i+1, j-1 {
		page.Messages[i], page.Messages[j] = page.Messages[j], page.Messages[i]
	}
	return page, err
}

func (s *PostgresStore) WriteMessage(room, user, id, body, replyID string) (Message, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	// Allocate per-room message order only after earlier room writes commit.
	// Otherwise a late commit with a lower sequence could land behind a read cursor.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, room); err != nil {
		return Message{}, err
	}
	// Lock membership until the write commits; a revoked member cannot race a
	// successful permission check and add content after removal has committed.
	var member string
	if err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE`, room, user).Scan(&member); err != nil {
		return Message{}, ErrForbidden
	}
	if id != "" {
		var author string
		var deleted bool
		err = tx.QueryRow(ctx, `SELECT author_id::text,deleted_at IS NOT NULL FROM messages WHERE room_id=$1 AND id=$2 FOR UPDATE`, room, id).Scan(&author, &deleted)
		if err != nil {
			return Message{}, norm(err)
		}
		if author != user {
			return Message{}, ErrForbidden
		}
		if deleted {
			return Message{}, ErrNotFound
		}
	} else if replyID != "" {
		var found string
		if !uuidPattern.MatchString(replyID) {
			return Message{}, ErrNotFound
		}
		err = tx.QueryRow(ctx, `SELECT id::text FROM messages WHERE room_id=$1 AND id=$2 FOR SHARE`, room, replyID).Scan(&found)
		if err != nil {
			return Message{}, norm(err)
		}
	}
	mentions := map[string]bool{}
	for _, match := range mentionPattern.FindAllStringSubmatch(body, -1) {
		uid := strings.ToLower(match[1])
		if !uuidPattern.MatchString(uid) {
			return Message{}, ErrNotFound
		}
		mentions[uid] = true
	}
	if len(mentions) > 50 {
		return Message{}, ErrForbidden
	}
	for uid := range mentions {
		var found string
		if err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE`, room, uid).Scan(&found); err != nil {
			return Message{}, ErrForbidden
		}
	}
	if id == "" {
		err = tx.QueryRow(ctx, `INSERT INTO messages(room_id,author_id,body,reply_to_id) VALUES($1,$2,$3,NULLIF($4,'')::uuid) RETURNING id::text`, room, user, body, replyID).Scan(&id)
	} else {
		_, err = tx.Exec(ctx, `UPDATE messages SET body=$3,edited_at=clock_timestamp(),version=version+1 WHERE room_id=$1 AND id=$2`, room, id, body)
	}
	if err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM message_mentions WHERE message_id=$1`, id); err != nil {
		return Message{}, err
	}
	for uid := range mentions {
		if _, err = tx.Exec(ctx, `INSERT INTO message_mentions(message_id,user_id) VALUES($1,$2)`, id, uid); err != nil {
			return Message{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Message{}, err
	}
	return s.MessageByID(room, id)
}

func (s *PostgresStore) DeleteMessage(room, user, id string) (Message, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	var member string
	if err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE`, room, user).Scan(&member); err != nil {
		return Message{}, ErrForbidden
	}
	var author string
	err = tx.QueryRow(ctx, `SELECT author_id::text FROM messages WHERE room_id=$1 AND id=$2 FOR UPDATE`, room, id).Scan(&author)
	if err != nil {
		return Message{}, norm(err)
	}
	if author != user {
		return Message{}, ErrForbidden
	}
	_, err = tx.Exec(ctx, `UPDATE messages SET body='',deleted_at=COALESCE(deleted_at,clock_timestamp()),version=version+1 WHERE id=$1`, id)
	if err != nil {
		return Message{}, err
	}
	for _, table := range []string{"message_mentions", "message_reactions"} {
		if _, err = tx.Exec(ctx, `DELETE FROM `+table+` WHERE message_id=$1`, id); err != nil {
			return Message{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Message{}, err
	}
	return s.MessageByID(room, id)
}

func (s *PostgresStore) ReactMessage(room, user, id, emoji string, remove bool) (Message, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	var member string
	if err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE`, room, user).Scan(&member); err != nil {
		return Message{}, ErrForbidden
	}
	var found string
	err = tx.QueryRow(ctx, `SELECT m.id::text FROM messages m JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$3 WHERE m.room_id=$1 AND m.id=$2 AND m.deleted_at IS NULL FOR UPDATE OF m`, room, id, user).Scan(&found)
	if err != nil {
		return Message{}, norm(err)
	}
	if remove {
		_, err = tx.Exec(ctx, `DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`, id, user, emoji)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, id, user, emoji)
	}
	if err != nil {
		return Message{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE messages SET version=version+1 WHERE id=$1`, id)
	if err != nil {
		return Message{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Message{}, err
	}
	return s.MessageByID(room, id)
}

func (s *PostgresStore) SearchMessages(user, room, author, query, beforeID string, limit int) (MessagePage, error) {
	var before int64 = 9223372036854775807
	if beforeID != "" {
		if !uuidPattern.MatchString(beforeID) {
			return MessagePage{}, ErrNotFound
		}
		err := s.DB.QueryRow(context.Background(), `SELECT m.sequence FROM messages m JOIN room_members rm ON rm.room_id=m.room_id WHERE m.id=$1 AND rm.user_id=$2`, beforeID, user).Scan(&before)
		if err != nil {
			return MessagePage{}, norm(err)
		}
	}
	rows, err := s.DB.Query(context.Background(), messageSelect+` WHERE m.deleted_at IS NULL AND m.sequence<$5 AND EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=m.room_id AND rm.user_id=$1) AND ($2='' OR m.room_id=NULLIF($2,'')::uuid) AND ($3='' OR m.author_id=NULLIF($3,'')::uuid) AND to_tsvector('simple',m.body) @@ websearch_to_tsquery('simple',$4) ORDER BY m.sequence DESC LIMIT $6`, user, room, author, query, before, limit+1)
	if err != nil {
		return MessagePage{}, err
	}
	return messageRows(rows, limit)
}

func (s *PostgresStore) UnreadRooms(user string) ([]RoomUnread, error) {
	rows, err := s.DB.Query(context.Background(), `SELECT rm.room_id::text,COALESCE(rr.sequence,0),count(m.id),count(mm.message_id) FROM room_members rm LEFT JOIN room_reads rr ON rr.room_id=rm.room_id AND rr.user_id=rm.user_id LEFT JOIN messages m ON m.room_id=rm.room_id AND m.sequence>COALESCE(rr.sequence,0) AND m.author_id<>rm.user_id AND m.deleted_at IS NULL LEFT JOIN message_mentions mm ON mm.message_id=m.id AND mm.user_id=rm.user_id WHERE rm.user_id=$1 GROUP BY rm.room_id,rr.sequence`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RoomUnread{}
	for rows.Next() {
		var r RoomUnread
		if err = rows.Scan(&r.RoomID, &r.ReadSequence, &r.Unread, &r.Mentions); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *PostgresStore) ReadRoom(room, user, messageID string) error {
	tag, err := s.DB.Exec(context.Background(), `INSERT INTO room_reads(room_id,user_id,sequence) SELECT m.room_id,$2,m.sequence FROM messages m JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$2 WHERE m.room_id=$1 AND m.id=$3 ON CONFLICT(room_id,user_id) DO UPDATE SET sequence=GREATEST(room_reads.sequence,EXCLUDED.sequence)`, room, user, messageID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}
