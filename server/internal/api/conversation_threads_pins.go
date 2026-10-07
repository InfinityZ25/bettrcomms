package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

func (s *PostgresStore) ThreadPage(room, user, root, beforeID string, after *int64, limit int) (MessagePage, error) {
	ctx := context.Background()
	parent, err := scanMessage(s.DB.QueryRow(ctx, messageSelect+` WHERE m.room_id=$1 AND m.id=$2 AND m.thread_root_id IS NULL AND can_access_room(m.room_id,$3)`, room, root, user))
	if err != nil {
		return MessagePage{}, err
	}
	cursor := int64(9223372036854775807)
	if beforeID != "" {
		if !uuidPattern.MatchString(beforeID) {
			return MessagePage{}, ErrNotFound
		}
		if err = s.DB.QueryRow(ctx, `SELECT sequence FROM messages WHERE room_id=$1 AND thread_root_id=$2 AND id=$3`, room, root, beforeID).Scan(&cursor); err != nil {
			return MessagePage{}, norm(err)
		}
	}
	condition, order := `m.sequence<$4`, `DESC`
	if after != nil {
		cursor = *after
		condition = `m.sequence>$4`
		order = `ASC`
	}
	rows, err := s.DB.Query(ctx, messageSelect+` WHERE m.room_id=$1 AND m.thread_root_id=$2 AND can_access_room(m.room_id,$3) AND `+condition+` ORDER BY m.sequence `+order+` LIMIT $5`, room, root, user, cursor, limit+1)
	if err != nil {
		return MessagePage{}, err
	}
	page, err := messageRows(rows, limit)
	if err != nil {
		return page, err
	}
	if after == nil {
		for i, j := 0, len(page.Messages)-1; i < j; i, j = i+1, j-1 {
			page.Messages[i], page.Messages[j] = page.Messages[j], page.Messages[i]
		}
	}
	page.Root = &parent
	err = s.DB.QueryRow(ctx, `SELECT COALESCE((SELECT sequence FROM thread_reads WHERE root_id=$1 AND user_id=$2),0)`, root, user).Scan(&page.ReadSequence)
	return page, err
}

func (s *PostgresStore) ReadThread(room, user, root, id string) error {
	tag, err := s.DB.Exec(context.Background(), `INSERT INTO thread_reads(room_id,root_id,user_id,sequence)
 SELECT m.room_id,m.thread_root_id,$2,m.sequence FROM messages m
 WHERE m.room_id=$1 AND m.id=$4 AND m.thread_root_id=$3 AND can_access_room(m.room_id,$2)
 ON CONFLICT(root_id,user_id) DO UPDATE SET sequence=GREATEST(thread_reads.sequence,EXCLUDED.sequence)`, room, user, root, id)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (s *PostgresStore) ListThreads(room, user, beforeID string, limit int) (MessagePage, error) {
	ctx := context.Background()
	cursor := int64(9223372036854775807)
	if beforeID != "" {
		if !uuidPattern.MatchString(beforeID) {
			return MessagePage{}, ErrNotFound
		}
		if err := s.DB.QueryRow(ctx, `SELECT thread_last_sequence FROM messages WHERE room_id=$1 AND id=$2 AND thread_last_sequence IS NOT NULL AND can_access_room(room_id,$3)`, room, beforeID, user).Scan(&cursor); err != nil {
			return MessagePage{}, norm(err)
		}
	}
	rows, err := s.DB.Query(ctx, messageSelect+` WHERE m.room_id=$1 AND m.thread_last_sequence IS NOT NULL AND m.thread_root_id IS NULL AND can_access_room(m.room_id,$2) AND m.thread_last_sequence<$3 ORDER BY m.thread_last_sequence DESC LIMIT $4`, room, user, cursor, limit+1)
	if err != nil {
		return MessagePage{}, err
	}
	page, err := messageRows(rows, limit)
	if err != nil {
		return page, err
	}
	ids := []string{}
	for _, root := range page.Messages {
		ids = append(ids, root.ID)
	}
	counts, err := s.DB.Query(ctx, `SELECT m.thread_root_id::text,count(*) FROM messages m LEFT JOIN thread_reads tr ON tr.root_id=m.thread_root_id AND tr.user_id=$2 WHERE m.room_id=$1 AND m.thread_root_id=ANY($3::uuid[]) AND m.author_id<>$2 AND m.deleted_at IS NULL AND m.sequence>COALESCE(tr.sequence,0) GROUP BY m.thread_root_id`, room, user, ids)
	if err != nil {
		return page, err
	}
	defer counts.Close()
	unread := map[string]int64{}
	for counts.Next() {
		var id string
		var n int64
		if err = counts.Scan(&id, &n); err != nil {
			return page, err
		}
		unread[id] = n
	}
	for i := range page.Messages {
		page.Messages[i].ThreadUnreadCount = unread[page.Messages[i].ID]
	}
	return page, counts.Err()
}

func (s *PostgresStore) ListPins(room, user string) ([]Message, error) {
	rows, err := s.DB.Query(context.Background(), messageSelect+` JOIN message_pins pin ON pin.message_id=m.id WHERE m.room_id=$1 AND m.deleted_at IS NULL AND can_access_room(m.room_id,$2) ORDER BY pin.created_at DESC,m.id LIMIT 50`, room, user)
	if err != nil {
		return nil, err
	}
	page, err := messageRows(rows, 50)
	return page.Messages, err
}

func (s *PostgresStore) PinMessage(room, user, id string, remove bool) (Message, error) {
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
	var allowed bool
	if err = tx.QueryRow(ctx, `SELECT room_has_permission($1,$2,'pin_messages')`, room, user).Scan(&allowed); err != nil {
		return Message{}, err
	}
	if !allowed {
		return Message{}, ErrForbidden
	}
	var member string
	if err = tx.QueryRow(ctx, `SELECT user_id::text FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE`, room, user).Scan(&member); err != nil {
		return Message{}, ErrForbidden
	}
	var found string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM messages WHERE room_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, room, id).Scan(&found); err != nil {
		return Message{}, norm(err)
	}
	if remove {
		_, err = tx.Exec(ctx, `DELETE FROM message_pins WHERE message_id=$1`, id)
	} else {
		var count int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM message_pins WHERE room_id=$1 AND message_id<>$2`, room, id).Scan(&count); err != nil {
			return Message{}, err
		}
		if count >= 50 {
			return Message{}, ErrConflict
		}
		_, err = tx.Exec(ctx, `INSERT INTO message_pins(room_id,message_id,pinned_by) VALUES($1,$2,$3) ON CONFLICT(message_id) DO NOTHING`, room, id, user)
	}
	if err != nil {
		return Message{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE messages SET version=version+1 WHERE id=$1`, id); err != nil {
		return Message{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Message{}, err
	}
	return s.MessageByID(room, id)
}

// Called only after room() has checked current membership.
func (a *API) conversationControls(w http.ResponseWriter, r *http.Request, u User, p []string) {
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "conversation controls unavailable")
		return
	}
	room := p[1]
	switch {
	case len(p) == 3 && p[2] == "threads" && r.Method == "GET":
		page, err := store.ListThreads(room, u.ID, r.URL.Query().Get("before_id"), pageLimit(r))
		a.result(w, page, err)
	case len(p) == 3 && p[2] == "pins" && r.Method == "GET":
		pins, err := store.ListPins(room, u.ID)
		a.result(w, map[string]any{"messages": pins}, err)
	case len(p) == 5 && p[2] == "messages" && p[4] == "pin" && (r.Method == "PUT" || r.Method == "DELETE"):
		if !uuidPattern.MatchString(p[3]) {
			a.fail(w, 404, "not_found", "message not found")
			return
		}
		if !a.limiter.allow("message-pin:"+u.ID, 60, time.Minute) {
			a.fail(w, 429, "rate_limited", "too many pin actions")
			return
		}
		message, err := store.PinMessage(room, u.ID, p[3], r.Method == "DELETE")
		if err == nil {
			a.publishChatUpdate(message)
		}
		a.result(w, map[string]any{"message": message}, err)
	case len(p) == 5 && p[2] == "threads" && p[4] == "messages" && r.Method == "GET":
		if !uuidPattern.MatchString(p[3]) {
			a.fail(w, 404, "not_found", "thread not found")
			return
		}
		var after *int64
		if value := r.URL.Query().Get("after_sequence"); value != "" {
			n, err := strconv.ParseInt(value, 10, 64)
			if err != nil || n < 0 || r.URL.Query().Get("before_id") != "" {
				a.fail(w, 400, "invalid_cursor", "choose one valid cursor")
				return
			}
			after = &n
		}
		page, err := store.ThreadPage(room, u.ID, p[3], r.URL.Query().Get("before_id"), after, pageLimit(r))
		a.result(w, page, err)
	case len(p) == 5 && p[2] == "threads" && p[4] == "read" && r.Method == "PUT":
		var in struct {
			MessageID string `json:"message_id"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if !uuidPattern.MatchString(p[3]) || !uuidPattern.MatchString(in.MessageID) {
			a.fail(w, 400, "invalid_message", "choose a reply in this thread")
			return
		}
		err := store.ReadThread(room, u.ID, p[3], in.MessageID)
		if err == nil {
			data, _ := json.Marshal(map[string]string{"room_id": room, "thread_root_id": p[3]})
			a.Realtime.publishUser(u.ID, wire{Type: "chat.read", Payload: data})
		}
		a.result(w, map[string]bool{"ok": true}, err)
	default:
		a.fail(w, 405, "method_not_allowed", "method not allowed")
	}
}

func (a *API) publishChatUpdate(message Message) {
	data, _ := json.Marshal(message)
	event := wire{Type: "chat.updated", Payload: data}
	a.Hub.broadcast(message.RoomID, nil, event)
	a.Realtime.publishRoom(message.RoomID, event)
}
