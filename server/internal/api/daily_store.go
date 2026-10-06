package api

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
)

const publicUserCols = `u.id::text,u.name,u.username,u.bio,u.avatar_url,u.created_at,u.profile_version,
 CASE WHEN st.expires_at IS NULL OR st.expires_at>clock_timestamp() THEN COALESCE(st.text,'') ELSE '' END,
 CASE WHEN st.expires_at IS NULL OR st.expires_at>clock_timestamp() THEN COALESCE(st.emoji,'') ELSE '' END,
 CASE WHEN st.expires_at>clock_timestamp() THEN st.expires_at END,COALESCE(st.version,0)`

func scanPublicUser(row pgx.Row) (PublicUser, error) {
	var u PublicUser
	e := row.Scan(&u.ID, &u.Name, &u.Username, &u.Bio, &u.AvatarURL, &u.CreatedAt, &u.ProfileVersion, &u.CustomStatus.Text, &u.CustomStatus.Emoji, &u.CustomStatus.ExpiresAt, &u.StatusVersion)
	return u, norm(e)
}

const unblockedPair = `NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=$2) OR (b.blocker_id=$2 AND b.blocked_id=$1))`

func (s *PostgresStore) PublicProfile(target, viewer string) (UserProfile, error) {
	ctx := context.Background()
	result := UserProfile{SharedRooms: []Room{}, MutualFriends: []PublicUser{}}
	var relation, request string
	e := s.DB.QueryRow(ctx, `SELECT CASE WHEN $1=$2 THEN 'self' WHEN f.status='accepted' THEN 'friend' WHEN f.sender_id=$2 THEN 'outgoing_request' WHEN f.receiver_id=$2 THEN 'incoming_request' ELSE 'shared_room' END,COALESCE(CASE WHEN f.status='pending' THEN f.id::text END,'') FROM users u LEFT JOIN friend_requests f ON (f.sender_id=$1 AND f.receiver_id=$2) OR (f.sender_id=$2 AND f.receiver_id=$1) WHERE u.id=$1 AND u.deleted_at IS NULL AND ($1=$2 OR (`+unblockedPair+` AND (f.id IS NOT NULL OR EXISTS(SELECT 1 FROM room_members a JOIN room_members b ON b.room_id=a.room_id AND b.user_id=$1 WHERE a.user_id=$2 AND can_access_room(a.room_id,$2) AND can_access_room(a.room_id,$1)))))`, target, viewer).Scan(&relation, &request)
	if e != nil {
		return result, norm(e)
	}
	result.Relationship, result.FriendRequestID = relation, request
	result.User, e = scanPublicUser(s.DB.QueryRow(ctx, `SELECT `+publicUserCols+` FROM users u LEFT JOIN user_custom_status st ON st.user_id=u.id WHERE u.id=$1 AND u.deleted_at IS NULL`, target))
	if e != nil {
		return result, e
	}
	rows, e := s.DB.Query(ctx, `SELECT r.id::text,r.name,r.owner_id::text,a.role,r.kind,r.created_at,r.slow_mode_seconds FROM rooms r JOIN room_members a ON a.room_id=r.id AND a.user_id=$2 JOIN room_members b ON b.room_id=r.id AND b.user_id=$1 WHERE can_access_room(r.id,$2) AND can_access_room(r.id,$1) ORDER BY r.created_at DESC,r.id LIMIT 20`, target, viewer)
	if e != nil {
		return result, e
	}
	for rows.Next() {
		var r Room
		if e = rows.Scan(&r.ID, &r.Name, &r.OwnerID, &r.Role, &r.Kind, &r.CreatedAt, &r.SlowModeSeconds); e != nil {
			rows.Close()
			return result, e
		}
		r.ActivityAt = r.CreatedAt
		result.SharedRooms = append(result.SharedRooms, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return result, e
	}
	// Only intersections of accepted friendships are visible, with blocks checked
	// against both people. Neither private room names nor email addresses enter it.
	rows, e = s.DB.Query(ctx, `WITH left_friends AS (SELECT CASE WHEN sender_id=$1 THEN receiver_id ELSE sender_id END id FROM friend_requests WHERE status='accepted' AND (sender_id=$1 OR receiver_id=$1)),right_friends AS (SELECT CASE WHEN sender_id=$2 THEN receiver_id ELSE sender_id END id FROM friend_requests WHERE status='accepted' AND (sender_id=$2 OR receiver_id=$2)) SELECT `+publicUserCols+` FROM users u JOIN left_friends l ON l.id=u.id JOIN right_friends r ON r.id=u.id LEFT JOIN user_custom_status st ON st.user_id=u.id WHERE u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id IN($1,$2) AND b.blocked_id=u.id) OR (b.blocked_id IN($1,$2) AND b.blocker_id=u.id)) ORDER BY u.name,u.id LIMIT 20`, target, viewer)
	if e != nil {
		return result, e
	}
	defer rows.Close()
	for rows.Next() {
		u, e := scanPublicUser(rows)
		if e != nil {
			return result, e
		}
		result.MutualFriends = append(result.MutualFriends, u)
	}
	return result, rows.Err()
}
func (s *PostgresStore) CustomStatus(user string) (StatusSnapshot, error) {
	var v StatusSnapshot
	err := s.DB.QueryRow(context.Background(), `SELECT CASE WHEN c.expires_at IS NULL OR c.expires_at>clock_timestamp() THEN COALESCE(c.text,'') ELSE '' END,CASE WHEN c.expires_at IS NULL OR c.expires_at>clock_timestamp() THEN COALESCE(c.emoji,'') ELSE '' END,CASE WHEN c.expires_at>clock_timestamp() THEN c.expires_at END,COALESCE(c.version,0) FROM users u LEFT JOIN user_custom_status c ON c.user_id=u.id WHERE u.id=$1 AND u.deleted_at IS NULL`, user).Scan(&v.Status.Text, &v.Status.Emoji, &v.Status.ExpiresAt, &v.Version)
	return v, norm(err)
}
func (s *PostgresStore) populateFriendStatuses(viewer string, users []User) error {
	if len(users) == 0 {
		return nil
	}
	ids := make([]string, len(users))
	positions := make(map[string]int, len(users))
	for i, u := range users {
		ids[i] = u.ID
		positions[u.ID] = i
	}
	rows, e := s.DB.Query(context.Background(), `SELECT u.id::text,
 CASE WHEN c.expires_at IS NULL OR c.expires_at>clock_timestamp() THEN COALESCE(c.text,'') ELSE '' END,
 CASE WHEN c.expires_at IS NULL OR c.expires_at>clock_timestamp() THEN COALESCE(c.emoji,'') ELSE '' END,
 CASE WHEN c.expires_at>clock_timestamp() THEN c.expires_at END,COALESCE(c.version,0)
 FROM users u LEFT JOIN user_custom_status c ON c.user_id=u.id WHERE u.id=ANY($1::uuid[]) AND u.deleted_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$2 AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=$2))
 AND EXISTS(SELECT 1 FROM friend_requests f WHERE f.status='accepted' AND ((f.sender_id=$2 AND f.receiver_id=u.id) OR (f.receiver_id=$2 AND f.sender_id=u.id)))`, ids, viewer)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var v StatusSnapshot
		if e = rows.Scan(&id, &v.Status.Text, &v.Status.Emoji, &v.Status.ExpiresAt, &v.Version); e != nil {
			return e
		}
		if i, ok := positions[id]; ok {
			status := v.Status
			users[i].CustomStatus = &status
			users[i].StatusVersion = v.Version
		}
	}
	return rows.Err()
}
func (s *PostgresStore) SetCustomStatus(user string, status CustomStatus) (StatusSnapshot, error) {
	v := StatusSnapshot{Status: status}
	err := s.DB.QueryRow(context.Background(), `INSERT INTO user_custom_status(user_id,text,emoji,expires_at) SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL) ON CONFLICT(user_id) DO UPDATE SET text=EXCLUDED.text,emoji=EXCLUDED.emoji,expires_at=EXCLUDED.expires_at,version=user_custom_status.version+1 RETURNING version`, user, status.Text, status.Emoji, status.ExpiresAt).Scan(&v.Version)
	return v, norm(err)
}
func (s *PostgresStore) StatusRecipients(user string) ([]string, error) {
	return s.statusRecipientsContext(context.Background(), user)
}
func (s *PostgresStore) statusRecipientsContext(ctx context.Context, user string) ([]string, error) {
	rows, e := s.DB.Query(ctx, `WITH recipients AS (
 SELECT $1::uuid id UNION
 SELECT CASE WHEN f.sender_id=$1 THEN f.receiver_id ELSE f.sender_id END FROM friend_requests f WHERE f.status='accepted' AND (f.sender_id=$1 OR f.receiver_id=$1) UNION
 SELECT b.user_id FROM room_members a JOIN room_members b ON b.room_id=a.room_id WHERE a.user_id=$1 AND can_access_room(a.room_id,$1) AND can_access_room(a.room_id,b.user_id)
 ) SELECT u.id::text FROM recipients r JOIN users u ON u.id=r.id WHERE u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=$1))`, user)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			return nil, e
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
func (s *PostgresStore) ConversationPreferences(user string) (map[string]ConversationPreference, error) {
	rows, e := s.DB.Query(context.Background(), `SELECT p.room_id::text,p.favorite,p.archived,p.version FROM conversation_preferences p WHERE p.user_id=$1 AND can_access_room(p.room_id,$1)`, user)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := map[string]ConversationPreference{}
	for rows.Next() {
		var id string
		var v ConversationPreference
		if e = rows.Scan(&id, &v.Favorite, &v.Archived, &v.Version); e != nil {
			return nil, e
		}
		out[id] = v
	}
	return out, rows.Err()
}
func (s *PostgresStore) SetConversationPreference(room, user string, favorite, archived *bool) (ConversationPreference, error) {
	var v ConversationPreference
	e := s.DB.QueryRow(context.Background(), `INSERT INTO conversation_preferences(room_id,user_id,favorite,archived) SELECT $1,$2,COALESCE($3,false),COALESCE($4,false) FROM rooms r WHERE r.id=$1 AND can_access_room($1,$2) AND (r.kind IN('direct','group') OR NOT COALESCE($4,false)) ON CONFLICT(room_id,user_id) DO UPDATE SET favorite=COALESCE($3,conversation_preferences.favorite),archived=COALESCE($4,conversation_preferences.archived),version=conversation_preferences.version+1 RETURNING favorite,archived,version`, room, user, favorite, archived).Scan(&v.Favorite, &v.Archived, &v.Version)
	if e == pgx.ErrNoRows {
		return v, ErrForbidden
	}
	return v, e
}
func (s *PostgresStore) AccountPreferences(user string) (AccountPreferences, error) {
	v := AccountPreferences{Settings: map[string]json.RawMessage{}}
	var raw []byte
	e := s.DB.QueryRow(context.Background(), `SELECT COALESCE(p.version,0),COALESCE(p.settings,'{}') FROM users u LEFT JOIN account_preferences p ON p.user_id=u.id WHERE u.id=$1 AND u.deleted_at IS NULL`, user).Scan(&v.Version, &raw)
	if e != nil {
		return v, norm(e)
	}
	e = json.Unmarshal(raw, &v.Settings)
	return v, e
}
func (s *PostgresStore) PatchAccountPreferences(user string, version int64, settings map[string]json.RawMessage) (AccountPreferences, error) {
	ctx := context.Background()
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return AccountPreferences{}, e
	}
	defer tx.Rollback(ctx)
	// Lock the existing account rather than creating a preference row for GET.
	// The same lock serializes deletion and two first-time writes from devices.
	var id string
	e = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, user).Scan(&id)
	if e != nil {
		return AccountPreferences{}, norm(e)
	}
	current := AccountPreferences{Settings: map[string]json.RawMessage{}}
	var raw []byte
	e = tx.QueryRow(ctx, `SELECT version,settings FROM account_preferences WHERE user_id=$1`, user).Scan(&current.Version, &raw)
	if e != nil && e != pgx.ErrNoRows {
		return current, e
	}
	if e == nil {
		if e = json.Unmarshal(raw, &current.Settings); e != nil {
			return current, e
		}
	}
	if current.Version != version {
		return current, ErrConflict
	}
	for key, value := range settings {
		if key == "sounds" && current.Settings[key] != nil {
			var previous, next map[string]json.RawMessage
			if e = json.Unmarshal(current.Settings[key], &previous); e != nil {
				return current, e
			}
			if e = json.Unmarshal(value, &next); e != nil {
				return current, e
			}
			for k, v := range next {
				previous[k] = v
			}
			value, e = json.Marshal(previous)
			if e != nil {
				return current, e
			}
		}
		current.Settings[key] = value
	}
	raw, e = json.Marshal(current.Settings)
	if e != nil {
		return current, e
	}
	current.Version++
	_, e = tx.Exec(ctx, `INSERT INTO account_preferences(user_id,version,settings) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET version=EXCLUDED.version,settings=EXCLUDED.settings`, user, current.Version, raw)
	if e != nil {
		return current, e
	}
	return current, tx.Commit(ctx)
}

// One process-wide task clears at most 100 expired rows per tick. Reads already
// hide expired values, so backlog cannot keep a status visible past its deadline.
func (a *API) ExpireCustomStatuses(ctx context.Context) error {
	s, ok := a.Store.(*PostgresStore)
	if !ok {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Maintenance can wait for its next tick rather than queue behind account
	// deletion or membership changes whose mutex cannot be context-cancelled.
	if !a.accessMu.TryRLock() {
		return nil
	}
	defer a.accessMu.RUnlock()
	rows, e := s.DB.Query(ctx, `UPDATE user_custom_status c SET text='',emoji='',expires_at=NULL,version=c.version+1 WHERE c.user_id IN(SELECT user_id FROM user_custom_status WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING c.user_id::text,c.version`)
	if e != nil {
		return e
	}
	type expired struct {
		id      string
		version int64
	}
	values := []expired{}
	for rows.Next() {
		var v expired
		if e = rows.Scan(&v.id, &v.version); e != nil {
			rows.Close()
			return e
		}
		values = append(values, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, v := range values {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		a.publishCustomStatusContext(ctx, v.id, StatusSnapshot{Version: v.version}, s)
	}
	return ctx.Err()
}

var _ DailyStore = (*PostgresStore)(nil)
