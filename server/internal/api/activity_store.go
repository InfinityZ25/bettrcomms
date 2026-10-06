package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"time"
)

func (s *PostgresStore) Activity(user, kind string, cursor activityCursor, limit int) (ActivityPage, error) {
	page := ActivityPage{Items: []ActivityItem{}}
	before := cursor.Time
	if before.IsZero() {
		before = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	// Build only the requested scope, retain one canonical item when a reply also
	// mentions the recipient, then page the union with a deterministic tuple.
	const candidates = `WITH relevant AS (
 SELECT mm.message_id id,'mention' kind FROM message_mentions mm JOIN messages m ON m.id=mm.message_id
 WHERE mm.user_id=$1 AND $2 IN('all','mentions') AND (m.created_at,'mention:'||m.id::text)<($3::timestamptz,$4::text)
 UNION ALL
 SELECT m.id,'reply' FROM messages parent JOIN messages m ON COALESCE(m.reply_to_id,m.thread_root_id)=parent.id
 WHERE parent.author_id=$1 AND parent.deleted_at IS NULL AND $2 IN('all','replies')
 AND ($2='replies' OR NOT EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=$1))
 AND (m.created_at,'reply:'||m.id::text)<($3::timestamptz,$4::text)
 ),message_activity AS (
 SELECT relevant.kind,m.id::text object_id,m.room_id::text room_id,m.created_at,
 m.sequence<=CASE WHEN m.thread_root_id IS NULL THEN COALESCE(rr.sequence,0) ELSE COALESCE(tr.sequence,0) END is_read,NULL::jsonb payload
 FROM relevant JOIN messages m ON m.id=relevant.id JOIN room_members member ON member.room_id=m.room_id AND member.user_id=$1
 LEFT JOIN room_reads rr ON rr.room_id=m.room_id AND rr.user_id=$1
 LEFT JOIN thread_reads tr ON tr.root_id=m.thread_root_id AND tr.user_id=$1
 WHERE m.deleted_at IS NULL AND m.author_id<>$1 AND can_access_room(m.room_id,$1)
 AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=m.author_id) OR (b.blocked_id=$1 AND b.blocker_id=m.author_id))
 ),request_activity AS (
 SELECT 'friend_request' kind,f.id::text object_id,'' room_id,f.created_at,false is_read,
 jsonb_build_object('id',f.id,'status',f.status,'created_at',f.created_at,'sender',jsonb_build_object('id',sender.id,'name',sender.name,'email',sender.email,'username',sender.username,'bio',sender.bio,'avatar_url',sender.avatar_url,'created_at',sender.created_at,'profile_version',sender.profile_version),'receiver',jsonb_build_object('id',receiver.id,'name',receiver.name,'email',receiver.email,'username',receiver.username,'bio',receiver.bio,'avatar_url',receiver.avatar_url,'created_at',receiver.created_at,'profile_version',receiver.profile_version)) payload
 FROM friend_requests f JOIN users sender ON sender.id=f.sender_id AND sender.deleted_at IS NULL JOIN users receiver ON receiver.id=f.receiver_id AND receiver.deleted_at IS NULL
 WHERE f.receiver_id=$1 AND f.status='pending' AND $2 IN('all','requests') AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=f.sender_id) OR (b.blocked_id=$1 AND b.blocker_id=f.sender_id))
 UNION ALL
 SELECT 'dm_request',d.id::text,'',d.created_at,false,jsonb_build_object('id',d.id,'sender_id',d.sender_id,'sender_name',sender.name,'receiver_id',d.receiver_id,'receiver_name',receiver.name,'body',d.body,'created_at',d.created_at)
 FROM dm_requests d JOIN users sender ON sender.id=d.sender_id AND sender.deleted_at IS NULL JOIN users receiver ON receiver.id=d.receiver_id AND receiver.deleted_at IS NULL
 WHERE d.receiver_id=$1 AND d.status='pending' AND $2 IN('all','requests') AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=d.sender_id) OR (b.blocked_id=$1 AND b.blocker_id=d.sender_id))
 ),activity AS(SELECT * FROM message_activity UNION ALL SELECT * FROM request_activity)
 SELECT kind||':'||object_id,kind,object_id,room_id,created_at,is_read,payload FROM activity
 WHERE (created_at,kind||':'||object_id)<($3::timestamptz,$4::text) ORDER BY created_at DESC,kind||':'||object_id DESC LIMIT $5`
	if cursor.ID == "" {
		cursor.ID = "~"
	}
	rows, e := s.DB.Query(context.Background(), candidates, user, kind, before, cursor.ID, limit+1)
	if e != nil {
		return page, e
	}
	type candidate struct {
		item   ActivityItem
		object string
	}
	found := []candidate{}
	messageIDs := []string{}
	for rows.Next() {
		var v candidate
		var payload []byte
		e = rows.Scan(&v.item.ID, &v.item.Kind, &v.object, &v.item.RoomID, &v.item.CreatedAt, &v.item.Read, &payload)
		if e != nil {
			rows.Close()
			return page, e
		}
		if v.item.Kind == "friend_request" {
			e = json.Unmarshal(payload, &v.item.FriendRequest)
		} else if v.item.Kind == "dm_request" {
			e = json.Unmarshal(payload, &v.item.DMRequest)
		} else {
			messageIDs = append(messageIDs, v.object)
		}
		if e != nil {
			rows.Close()
			return page, e
		}
		found = append(found, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return page, e
	}
	if len(found) > limit {
		found = found[:limit]
		last := found[len(found)-1].item
		raw, _ := json.Marshal(activityCursor{Time: last.CreatedAt, ID: last.ID})
		page.NextCursor = base64.RawURLEncoding.EncodeToString(raw)
	}
	messages := map[string]Message{}
	if len(messageIDs) > 0 {
		rows, e = s.DB.Query(context.Background(), messageSelect+` WHERE m.id=ANY($1::uuid[]) AND m.deleted_at IS NULL AND can_access_room(m.room_id,$2)`, messageIDs, user)
		if e != nil {
			return page, e
		}
		for rows.Next() {
			m, e := scanMessage(rows)
			if e != nil {
				rows.Close()
				return page, e
			}
			messages[m.ID] = m
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return page, e
		}
	}
	for _, v := range found {
		if v.item.Kind == "mention" || v.item.Kind == "reply" {
			m, ok := messages[v.object]
			if !ok {
				continue
			}
			v.item.Message = &m
		}
		page.Items = append(page.Items, v.item)
	}
	return page, nil
}
