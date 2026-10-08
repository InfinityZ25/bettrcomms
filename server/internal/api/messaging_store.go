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
	MessagesAfter(room, user string, after int64, limit int) (MessagePage, error)
	MessageByID(room, id string) (Message, error)
	WriteMessage(room, user, id, body, replyID string) (Message, error)
	SendMessage(room, user, body, replyID, nonce string, attachmentIDs []string) (Message, bool, error)
	DeleteMessage(room, user, id string) (Message, error)
	ReactMessage(room, user, id, emoji string, remove bool) (Message, error)
	SearchMessages(user, room, author, query, beforeID string, limit int) (MessagePage, error)
	UnreadRooms(user string) ([]RoomUnread, error)
	ReadRoom(room, user, messageID string) error
}

var mentionPattern = regexp.MustCompile(`<@([0-9a-fA-F-]{36})>`)

const messageSelect = `SELECT m.id::text,m.room_id::text,m.body,m.created_at,m.sequence,m.version,m.edited_at,m.deleted_at,
 u.id::text,u.email,u.name,u.avatar_url,u.created_at,u.username,u.bio,u.profile_version,
 CASE WHEN parent.id IS NOT NULL THEN jsonb_build_object('id',parent.id,'name',pu.name,'body',left(parent.body,400),'deleted',parent.deleted_at IS NOT NULL) END,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',mu.id,'name',mu.name) ORDER BY mu.id) FROM message_mentions mm JOIN users mu ON mu.id=mm.user_id WHERE mm.message_id=m.id),'[]'),
 COALESCE((SELECT jsonb_agg(jsonb_build_object('emoji',r.emoji,'users',r.users) ORDER BY r.emoji) FROM (SELECT emoji,jsonb_agg(user_id::text ORDER BY user_id) users FROM message_reactions WHERE message_id=m.id GROUP BY emoji) r),'[]'),
	COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id::text,'filename',a.filename,'content_type',a.content_type,'size_bytes',a.size_bytes,'voice_note',a.voice_note,'duration_ms',a.duration_ms) ORDER BY a.created_at) FROM message_attachments a WHERE (a.message_id=m.id OR a.id IN (SELECT asset.attachment_id FROM message_asset_links link JOIN channel_media_assets asset ON asset.id=link.asset_id WHERE link.message_id=m.id)) AND a.deleted_at IS NULL),'[]'),
 m.thread_root_id::text,(SELECT count(*) FROM messages tr WHERE tr.thread_root_id=m.id AND tr.deleted_at IS NULL),
 (SELECT created_at FROM message_pins WHERE message_id=m.id),(SELECT pinned_by::text FROM message_pins WHERE message_id=m.id)
 FROM messages m JOIN users u ON u.id=m.author_id LEFT JOIN messages parent ON parent.id=m.reply_to_id LEFT JOIN users pu ON pu.id=parent.author_id `

func scanMessage(row pgx.Row) (Message, error) {
	var m Message
	var reply, mentions, reactions, attachments []byte
	err := row.Scan(&m.ID, &m.RoomID, &m.Body, &m.CreatedAt, &m.Sequence, &m.Version, &m.EditedAt, &m.DeletedAt,
		&m.Author.ID, &m.Author.Email, &m.Author.Name, &m.Author.AvatarURL, &m.Author.CreatedAt, &m.Author.Username, &m.Author.Bio, &m.Author.ProfileVersion, &reply, &mentions, &reactions, &attachments,
		&m.ThreadRootID, &m.ThreadReplyCount, &m.PinnedAt, &m.PinnedBy)
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
	if err = json.Unmarshal(reactions, &m.Reactions); err != nil {
		return m, err
	}
	err = json.Unmarshal(attachments, &m.Attachments)
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
	rows, err := s.DB.Query(context.Background(), messageSelect+` WHERE m.room_id=$1 AND m.thread_root_id IS NULL AND m.sequence<$2 AND can_access_room(m.room_id,$3) ORDER BY m.sequence DESC LIMIT $4`, room, before, user, limit+1)
	if err != nil {
		return MessagePage{}, err
	}
	page, err := messageRows(rows, limit)
	for i, j := 0, len(page.Messages)-1; i < j; i, j = i+1, j-1 {
		page.Messages[i], page.Messages[j] = page.Messages[j], page.Messages[i]
	}
	if err == nil {
		err = s.DB.QueryRow(context.Background(), `SELECT COALESCE((SELECT sequence FROM room_reads WHERE room_id=$1 AND user_id=$2),0)`, room, user).Scan(&page.ReadSequence)
	}
	return page, err
}

func (s *PostgresStore) MessagesAfter(room, user string, after int64, limit int) (MessagePage, error) {
	if after < 0 {
		return MessagePage{}, ErrNotFound
	}
	rows, err := s.DB.Query(context.Background(), messageSelect+` WHERE m.room_id=$1 AND m.thread_root_id IS NULL AND m.sequence>$2 AND can_access_room(m.room_id,$3) ORDER BY m.sequence ASC LIMIT $4`, room, after, user, limit+1)
	if err != nil {
		return MessagePage{}, err
	}
	page, err := messageRows(rows, limit)
	if len(page.Messages) > 0 && page.BeforeID != "" {
		page.BeforeID = page.Messages[len(page.Messages)-1].ID
	}
	return page, err
}

func (s *PostgresStore) WriteMessage(room, user, id, body, replyID string) (Message, error) {
	message, _, err := s.writeMessage(room, user, id, body, replyID, "", nil, "")
	return message, err
}

func (s *PostgresStore) SendMessage(room, user, body, replyID, nonce string, attachmentIDs []string) (Message, bool, error) {
	return s.writeMessage(room, user, "", body, replyID, nonce, attachmentIDs, "")
}

func (s *PostgresStore) SendThreadMessage(room, user, body, replyID, nonce string, attachmentIDs []string, root string) (Message, bool, error) {
	return s.writeMessage(room, user, "", body, replyID, nonce, attachmentIDs, root)
}

func (s *PostgresStore) writeMessage(room, user, id, body, replyID, nonce string, attachmentIDs []string, root string) (Message, bool, error) {
	root = strings.ToLower(root)
	isNew := id == ""
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Message{}, false, err
	}
	defer tx.Rollback(ctx)
	if err = lockRoomCommunity(ctx, tx, room); err != nil {
		return Message{}, false, err
	}
	// Allocate per-room message order only after earlier room writes commit.
	// Otherwise a late commit with a lower sequence could land behind a read cursor.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))`, room); err != nil {
		return Message{}, false, err
	}
	var directKey *string
	if err = tx.QueryRow(ctx, `SELECT direct_key FROM rooms WHERE id=$1`, room).Scan(&directKey); err != nil {
		return Message{}, false, norm(err)
	}
	if directKey != nil {
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, *directKey); err != nil {
			return Message{}, false, err
		}
		var allowed bool
		if err = tx.QueryRow(ctx, `SELECT can_access_room($1,$2)`, room, user).Scan(&allowed); err != nil {
			return Message{}, false, err
		}
		if !allowed {
			return Message{}, false, ErrForbidden
		}
	}
	// Lock membership until the write commits; a revoked member cannot race a
	// successful permission check and add content after removal has committed.
	var lockedRoom string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM rooms WHERE id=$1 FOR SHARE`, room).Scan(&lockedRoom); err != nil {
		return Message{}, false, norm(err)
	}
	var member string
	if err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE`, room, user).Scan(&member); err != nil {
		return Message{}, false, ErrForbidden
	}
	if id == "" && nonce != "" {
		var existingID, existingBody, existingReply, existingRoot string
		err = tx.QueryRow(ctx, `SELECT id::text,body,COALESCE(reply_to_id::text,''),COALESCE(thread_root_id::text,'') FROM messages WHERE room_id=$1 AND author_id=$2 AND client_nonce=$3`, room, user, nonce).Scan(&existingID, &existingBody, &existingReply, &existingRoot)
		if err == nil {
			if existingBody != body || existingReply != replyID || existingRoot != root {
				return Message{}, false, ErrConflict
			}
			var ids []string
			rows, queryErr := tx.Query(ctx, `SELECT id::text FROM message_attachments WHERE message_id=$1 ORDER BY id`, existingID)
			if queryErr != nil {
				return Message{}, false, queryErr
			}
			for rows.Next() {
				var value string
				if scanErr := rows.Scan(&value); scanErr != nil {
					rows.Close()
					return Message{}, false, scanErr
				}
				ids = append(ids, value)
			}
			queryErr = rows.Err()
			rows.Close()
			if queryErr != nil {
				return Message{}, false, queryErr
			}
			if !sameIDs(ids, attachmentIDs) {
				return Message{}, false, ErrConflict
			}
			// Read through this transaction: asking the pool for a second
			// connection while holding the room lock can deadlock retries.
			message, getErr := scanMessage(tx.QueryRow(ctx, messageSelect+` WHERE m.room_id=$1 AND m.id=$2`, room, existingID))
			return message, false, getErr
		}
		if err != pgx.ErrNoRows {
			return Message{}, false, err
		}
	}
	if err = checkRoomPosting(ctx, tx, room, user, isNew); err != nil {
		return Message{}, false, err
	}
	if id != "" {
		var author string
		var deleted bool
		err = tx.QueryRow(ctx, `SELECT author_id::text,deleted_at IS NOT NULL,COALESCE(thread_root_id::text,'') FROM messages WHERE room_id=$1 AND id=$2 FOR UPDATE`, room, id).Scan(&author, &deleted, &root)
		if err != nil {
			return Message{}, false, norm(err)
		}
		if author != user {
			return Message{}, false, ErrForbidden
		}
		if deleted {
			return Message{}, false, ErrNotFound
		}
	} else {
		if root != "" {
			if !uuidPattern.MatchString(root) {
				return Message{}, false, ErrNotFound
			}
			var found string
			if err = tx.QueryRow(ctx, `SELECT id::text FROM messages WHERE room_id=$1 AND id=$2 AND thread_root_id IS NULL AND (deleted_at IS NULL OR EXISTS(SELECT 1 FROM messages child WHERE child.thread_root_id=messages.id)) FOR SHARE`, room, root).Scan(&found); err != nil {
				return Message{}, false, norm(err)
			}
		}
		if replyID != "" {
			var found string
			if !uuidPattern.MatchString(replyID) {
				return Message{}, false, ErrNotFound
			}
			err = tx.QueryRow(ctx, `SELECT id::text FROM messages WHERE room_id=$1 AND id=$2 AND (COALESCE(thread_root_id::text,'')=$3 OR id::text=$3) FOR SHARE`, room, replyID, root).Scan(&found)
			if err != nil {
				return Message{}, false, norm(err)
			}
		}
	}
	mentions := map[string]bool{}
	for _, match := range mentionPattern.FindAllStringSubmatch(body, -1) {
		uid := strings.ToLower(match[1])
		if !uuidPattern.MatchString(uid) {
			return Message{}, false, ErrNotFound
		}
		mentions[uid] = true
	}
	if len(mentions) > 50 {
		return Message{}, false, ErrForbidden
	}
	for uid := range mentions {
		var found string
		if err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE`, room, uid).Scan(&found); err != nil {
			return Message{}, false, ErrForbidden
		}
	}
	if id == "" && len(attachmentIDs) > 0 {
		if len(attachmentIDs) > 4 {
			return Message{}, false, ErrForbidden
		}
		seenAttachments := make(map[string]bool, len(attachmentIDs))
		for _, attachmentID := range attachmentIDs {
			if !uuidPattern.MatchString(attachmentID) {
				return Message{}, false, ErrNotFound
			}
			if seenAttachments[attachmentID] {
				return Message{}, false, ErrConflict
			}
			seenAttachments[attachmentID] = true
			var found string
			if err = tx.QueryRow(ctx, `SELECT id::text FROM message_attachments WHERE id=$1 AND room_id=$2 AND uploader_id=$3 AND message_id IS NULL AND upload_state='ready' AND deleted_at IS NULL AND created_at>now()-interval '24 hours' FOR UPDATE`, attachmentID, room, user).Scan(&found); err != nil {
				return Message{}, false, norm(err)
			}
		}
	}
	if id == "" {
		err = tx.QueryRow(ctx, `INSERT INTO messages(room_id,author_id,body,reply_to_id,client_nonce,thread_root_id) VALUES($1,$2,$3,NULLIF($4,'')::uuid,NULLIF($5,'')::uuid,NULLIF($6,'')::uuid) RETURNING id::text`, room, user, body, replyID, nonce, root).Scan(&id)
	} else {
		_, err = tx.Exec(ctx, `UPDATE messages SET body=$3,edited_at=clock_timestamp(),version=version+1 WHERE room_id=$1 AND id=$2`, room, id, body)
	}
	if err != nil {
		return Message{}, false, err
	}
	if isNew && root != "" {
		if _, err = tx.Exec(ctx, `UPDATE messages SET version=version+1,thread_last_sequence=(SELECT sequence FROM messages WHERE id=$2) WHERE id=$1`, root, id); err != nil {
			return Message{}, false, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO thread_reads(room_id,root_id,user_id,sequence) SELECT $1,$2,rm.user_id,COALESCE(rr.sequence,0) FROM room_members rm LEFT JOIN room_reads rr ON rr.room_id=rm.room_id AND rr.user_id=rm.user_id WHERE rm.room_id=$1 ON CONFLICT(root_id,user_id) DO NOTHING`, room, root); err != nil {
			return Message{}, false, err
		}
	}
	for _, attachmentID := range attachmentIDs {
		if _, err = tx.Exec(ctx, `UPDATE message_attachments SET message_id=$1 WHERE id=$2`, id, attachmentID); err != nil {
			return Message{}, false, err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM message_mentions WHERE message_id=$1`, id); err != nil {
		return Message{}, false, err
	}
	for uid := range mentions {
		if _, err = tx.Exec(ctx, `INSERT INTO message_mentions(message_id,user_id) VALUES($1,$2)`, id, uid); err != nil {
			return Message{}, false, err
		}
	}
	if isNew {
		// A delivery is queued only for subscriptions that already existed when
		// the message was committed. A retry with the same nonce exits above.
		_, err = tx.Exec(ctx, `INSERT INTO push_deliveries(message_id,subscription_id)
			SELECT $1, ps.id FROM room_members rm
			JOIN push_subscriptions ps ON ps.user_id=rm.user_id
			WHERE rm.room_id=$2 AND rm.user_id<>$3 AND NOT ps.dnd
			AND EXISTS(SELECT 1 FROM users recipient WHERE recipient.id=rm.user_id AND recipient.presence_status<>'dnd')
			ON CONFLICT DO NOTHING`, id, room, user)
		if err != nil {
			return Message{}, false, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Message{}, false, err
	}
	message, err := s.MessageByID(room, id)
	return message, true, err
}

func sameIDs(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	seen := make(map[string]bool, len(left))
	for _, id := range left {
		seen[id] = true
	}
	for _, id := range right {
		if !seen[id] {
			return false
		}
		delete(seen, id)
	}
	return len(seen) == 0
}

func (s *PostgresStore) DeleteMessage(room, user, id string) (Message, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	if err = lockRoomCommunity(ctx, tx, room); err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))`, room); err != nil {
		return Message{}, err
	}
	var member string
	if err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 AND can_access_room($1,$2) FOR SHARE`, room, user).Scan(&member); err != nil {
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
	if _, err = tx.Exec(ctx, `DELETE FROM message_pins WHERE message_id=$1`, id); err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE messages SET version=version+1 WHERE id=(SELECT thread_root_id FROM messages WHERE id=$1)`, id); err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE message_attachments SET deleted_at=clock_timestamp() WHERE message_id=$1 AND deleted_at IS NULL`, id); err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE message_reports SET status='resolved' WHERE message_id=$1 AND status='open'`, id); err != nil {
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
	if err = lockRoomCommunity(ctx, tx, room); err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,0))`, room); err != nil {
		return Message{}, err
	}
	if err = checkRoomPosting(ctx, tx, room, user, false); err != nil {
		return Message{}, err
	}
	var member string
	if err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE`, room, user).Scan(&member); err != nil {
		return Message{}, ErrForbidden
	}
	var found string
	err = tx.QueryRow(ctx, `SELECT m.id::text FROM messages m JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$3 WHERE m.room_id=$1 AND m.id=$2 AND m.deleted_at IS NULL FOR UPDATE OF m`, room, id, user).Scan(&found)
	if err != nil {
		return Message{}, norm(err)
	}
	if !remove {
		if err = checkReactionCapacity(ctx, tx, id, user, emoji); err != nil {
			return Message{}, err
		}
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
		err := s.DB.QueryRow(context.Background(), `SELECT m.sequence FROM messages m WHERE m.id=$1 AND can_access_room(m.room_id,$2)`, beforeID, user).Scan(&before)
		if err != nil {
			return MessagePage{}, norm(err)
		}
	}
	rows, err := s.DB.Query(context.Background(), messageSelect+` WHERE m.deleted_at IS NULL AND m.sequence<$5 AND can_access_room(m.room_id,$1) AND ($2='' OR m.room_id=NULLIF($2,'')::uuid) AND ($3='' OR m.author_id=NULLIF($3,'')::uuid) AND to_tsvector('simple',m.body) @@ websearch_to_tsquery('simple',$4) ORDER BY m.sequence DESC LIMIT $6`, user, room, author, query, before, limit+1)
	if err != nil {
		return MessagePage{}, err
	}
	return messageRows(rows, limit)
}

func (s *PostgresStore) UnreadRooms(user string) ([]RoomUnread, error) {
	rows, err := s.DB.Query(context.Background(), `SELECT rm.room_id::text,COALESCE(rr.sequence,0),counts.unread,counts.mentions
 FROM room_members rm LEFT JOIN room_reads rr ON rr.room_id=rm.room_id AND rr.user_id=rm.user_id
 CROSS JOIN LATERAL(
   SELECT count(m.id) unread,count(mm.message_id) mentions FROM (
     SELECT id FROM messages WHERE room_id=rm.room_id AND thread_root_id IS NULL AND sequence>COALESCE(rr.sequence,0) AND author_id<>rm.user_id AND deleted_at IS NULL
     UNION ALL
     SELECT child.id FROM thread_reads tr JOIN messages child ON child.thread_root_id=tr.root_id AND child.sequence>tr.sequence
     WHERE tr.room_id=rm.room_id AND tr.user_id=rm.user_id AND child.author_id<>rm.user_id AND child.deleted_at IS NULL
   ) m LEFT JOIN message_mentions mm ON mm.message_id=m.id AND mm.user_id=rm.user_id
 ) counts WHERE rm.user_id=$1 AND can_access_room(rm.room_id,$1)`, user)
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
	tag, err := s.DB.Exec(context.Background(), `INSERT INTO room_reads(room_id,user_id,sequence) SELECT m.room_id,$2,m.sequence FROM messages m JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$2 WHERE m.room_id=$1 AND m.id=$3 AND m.thread_root_id IS NULL AND can_access_room(m.room_id,$2) ON CONFLICT(room_id,user_id) DO UPDATE SET sequence=GREATEST(room_reads.sequence,EXCLUDED.sequence)`, room, user, messageID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}
