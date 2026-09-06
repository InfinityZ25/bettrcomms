package api

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ DB *pgxpool.Pool }

var ErrNotFound = errors.New("not found")
var ErrForbidden = errors.New("forbidden")

func (s *PostgresStore) CreateSession(ctx context.Context, h []byte, uid string, expires time.Time) error {
	_, e := s.DB.Exec(ctx, `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)`, h, uid, expires)
	return e
}
func (s *PostgresStore) SessionUser(ctx context.Context, h []byte, now time.Time) (string, error) {
	var id string
	e := s.DB.QueryRow(ctx, `SELECT user_id::text FROM sessions WHERE token_hash=$1 AND expires_at>$2`, h, now).Scan(&id)
	return id, norm(e)
}
func (s *PostgresStore) DeleteSession(ctx context.Context, h []byte) error {
	_, e := s.DB.Exec(ctx, `DELETE FROM sessions WHERE token_hash=$1`, h)
	return e
}
func (s *PostgresStore) DeleteExpiredSessions(ctx context.Context, now time.Time) error {
	_, e := s.DB.Exec(ctx, `DELETE FROM sessions WHERE expires_at<=$1`, now)
	return e
}

func norm(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

const userCols = `id::text,email,name,avatar_url,created_at`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.Name, &u.AvatarURL, &u.CreatedAt)
	return u, norm(err)
}
func (s *PostgresStore) UpsertUser(w, e, n string, a *string) (User, error) {
	return scanUser(s.DB.QueryRow(context.Background(), `INSERT INTO users(workos_user_id,email,name,avatar_url) VALUES($1,$2,$3,$4) ON CONFLICT(workos_user_id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,updated_at=now() RETURNING `+userCols, w, e, n, a))
}
func (s *PostgresStore) UpsertDevUser(e, n string) (User, error) {
	return scanUser(s.DB.QueryRow(context.Background(), `INSERT INTO users(email,name) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,updated_at=now() RETURNING `+userCols, e, n))
}
func (s *PostgresStore) UserByID(id string) (User, error) {
	return scanUser(s.DB.QueryRow(context.Background(), `SELECT `+userCols+` FROM users WHERE id=$1`, id))
}
func (s *PostgresStore) FindUsers(q, uid string) ([]User, error) {
	rows, e := s.DB.Query(context.Background(), `SELECT `+userCols+` FROM users WHERE id<>$2 AND (email ILIKE '%'||$1||'%' OR name ILIKE '%'||$1||'%') ORDER BY name LIMIT 20`, q, uid)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		if e = rows.Scan(&u.ID, &u.Email, &u.Name, &u.AvatarURL, &u.CreatedAt); e != nil {
			return nil, e
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
func (s *PostgresStore) ListRooms(uid string) ([]Room, error) {
	rows, e := s.DB.Query(context.Background(), `SELECT r.id::text,r.name,r.owner_id::text,rm.role,r.kind,r.created_at FROM rooms r JOIN room_members rm ON rm.room_id=r.id WHERE rm.user_id=$1 ORDER BY r.created_at DESC`, uid)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Room{}
	for rows.Next() {
		var r Room
		if e = rows.Scan(&r.ID, &r.Name, &r.OwnerID, &r.Role, &r.Kind, &r.CreatedAt); e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *PostgresStore) CreateRoom(uid, name string) (Room, error) {
	tx, e := s.DB.Begin(context.Background())
	if e != nil {
		return Room{}, e
	}
	defer tx.Rollback(context.Background())
	var r Room
	e = tx.QueryRow(context.Background(), `INSERT INTO rooms(name,owner_id) VALUES($1,$2) RETURNING id::text,name,owner_id::text,'owner',kind,created_at`, name, uid).Scan(&r.ID, &r.Name, &r.OwnerID, &r.Role, &r.Kind, &r.CreatedAt)
	if e != nil {
		return r, e
	}
	_, e = tx.Exec(context.Background(), `INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,'owner')`, r.ID, uid)
	if e != nil {
		return r, e
	}
	e = tx.Commit(context.Background())
	return r, e
}
func (s *PostgresStore) RoomForMember(rid, uid string) (Room, error) {
	var r Room
	e := s.DB.QueryRow(context.Background(), `SELECT r.id::text,r.name,r.owner_id::text,rm.role,r.kind,r.created_at FROM rooms r JOIN room_members rm ON rm.room_id=r.id WHERE r.id=$1 AND rm.user_id=$2`, rid, uid).Scan(&r.ID, &r.Name, &r.OwnerID, &r.Role, &r.Kind, &r.CreatedAt)
	return r, norm(e)
}
func (s *PostgresStore) CreateDirectRoom(uid, fid string) (Room, error) {
	tx, e := s.DB.Begin(context.Background())
	if e != nil {
		return Room{}, e
	}
	defer tx.Rollback(context.Background())
	var accepted bool
	e = tx.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM friend_requests WHERE status='accepted' AND ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)))`, uid, fid).Scan(&accepted)
	if e != nil {
		return Room{}, e
	}
	if !accepted {
		return Room{}, ErrForbidden
	}
	key := uid + ":" + fid
	if fid < uid {
		key = fid + ":" + uid
	}
	var rid string
	e = tx.QueryRow(context.Background(), `INSERT INTO rooms(name,owner_id,kind,direct_key) VALUES('Direct message',$1,'direct',$2) ON CONFLICT(direct_key) WHERE direct_key IS NOT NULL DO UPDATE SET direct_key=EXCLUDED.direct_key RETURNING id::text`, uid, key).Scan(&rid)
	if e != nil {
		return Room{}, e
	}
	_, e = tx.Exec(context.Background(), `INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member') ON CONFLICT DO NOTHING`, rid, uid, fid)
	if e != nil {
		return Room{}, e
	}
	if e = tx.Commit(context.Background()); e != nil {
		return Room{}, e
	}
	return s.RoomForMember(rid, uid)
}
func (s *PostgresStore) RenameRoom(rid, owner, name string) (Room, error) {
	tag, e := s.DB.Exec(context.Background(), `UPDATE rooms SET name=$3 WHERE id=$1 AND owner_id=$2 AND kind='channel'`, rid, owner, name)
	if e != nil {
		return Room{}, e
	}
	if tag.RowsAffected() == 0 {
		return Room{}, ErrForbidden
	}
	return s.RoomForMember(rid, owner)
}
func (s *PostgresStore) DeleteRoom(rid, owner string) error {
	tag, e := s.DB.Exec(context.Background(), `DELETE FROM rooms WHERE id=$1 AND owner_id=$2 AND kind='channel'`, rid, owner)
	if e == nil && tag.RowsAffected() == 0 {
		return ErrForbidden
	}
	return e
}
func (s *PostgresStore) RemoveRoomMember(rid, actor, target string) error {
	var owner, kind string
	e := s.DB.QueryRow(context.Background(), `SELECT owner_id::text,kind FROM rooms WHERE id=$1`, rid).Scan(&owner, &kind)
	if e != nil {
		return norm(e)
	}
	if kind != "channel" {
		return ErrForbidden
	}
	if target == owner {
		return ErrForbidden
	}
	if actor != owner && actor != target {
		return ErrForbidden
	}
	tag, e := s.DB.Exec(context.Background(), `DELETE FROM room_members WHERE room_id=$1 AND user_id=$2`, rid, target)
	if e == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return e
}
func (s *PostgresStore) ListRoomMembers(rid string) ([]RoomMember, error) {
	rows, e := s.DB.Query(context.Background(), `SELECT u.id::text,u.email,u.name,u.avatar_url,u.created_at,rm.role,rm.joined_at FROM room_members rm JOIN users u ON u.id=rm.user_id WHERE rm.room_id=$1 ORDER BY CASE rm.role WHEN 'owner' THEN 0 ELSE 1 END,u.name`, rid)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []RoomMember{}
	for rows.Next() {
		var m RoomMember
		if e = rows.Scan(&m.User.ID, &m.User.Email, &m.User.Name, &m.User.AvatarURL, &m.User.CreatedAt, &m.Role, &m.JoinedAt); e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (s *PostgresStore) AddRoomMember(rid, owner, newID string) error {
	var permitted bool
	e := s.DB.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM rooms WHERE id=$1 AND owner_id=$2) AND EXISTS(SELECT 1 FROM friend_requests WHERE status='accepted' AND ((sender_id=$2 AND receiver_id=$3) OR (sender_id=$3 AND receiver_id=$2)))`, rid, owner, newID).Scan(&permitted)
	if e != nil {
		return e
	}
	if !permitted {
		return ErrForbidden
	}
	_, e = s.DB.Exec(context.Background(), `INSERT INTO room_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, rid, newID)
	return e
}
func (s *PostgresStore) ListMessages(rid string, before time.Time, limit int) ([]Message, error) {
	rows, e := s.DB.Query(context.Background(), `SELECT m.id::text,m.room_id::text,m.body,m.created_at,u.id::text,u.email,u.name,u.avatar_url,u.created_at FROM messages m JOIN users u ON u.id=m.author_id WHERE m.room_id=$1 AND m.created_at<$2 ORDER BY m.created_at DESC LIMIT $3`, rid, before, limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		if e = rows.Scan(&m.ID, &m.RoomID, &m.Body, &m.CreatedAt, &m.Author.ID, &m.Author.Email, &m.Author.Name, &m.Author.AvatarURL, &m.Author.CreatedAt); e != nil {
			return nil, e
		}
		out = append([]Message{m}, out...)
	}
	return out, rows.Err()
}
func (s *PostgresStore) CreateMessage(rid, uid, body string) (Message, error) {
	var m Message
	e := s.DB.QueryRow(context.Background(), `INSERT INTO messages(room_id,author_id,body) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2) RETURNING id::text,room_id::text,body,created_at`, rid, uid, body).Scan(&m.ID, &m.RoomID, &m.Body, &m.CreatedAt)
	if e != nil {
		return m, norm(e)
	}
	m.Author, e = s.UserByID(uid)
	return m, e
}
func (s *PostgresStore) ListFriends(uid string) ([]User, []FriendRequest, error) {
	rows, e := s.DB.Query(context.Background(), `SELECT u.id::text,u.email,u.name,u.avatar_url,u.created_at FROM friend_requests f JOIN users u ON u.id=CASE WHEN f.sender_id=$1 THEN f.receiver_id ELSE f.sender_id END WHERE (f.sender_id=$1 OR f.receiver_id=$1) AND f.status='accepted' ORDER BY u.name`, uid)
	if e != nil {
		return nil, nil, e
	}
	friends := []User{}
	for rows.Next() {
		var u User
		if e = rows.Scan(&u.ID, &u.Email, &u.Name, &u.AvatarURL, &u.CreatedAt); e != nil {
			rows.Close()
			return nil, nil, e
		}
		friends = append(friends, u)
	}
	rows.Close()
	rows, e = s.DB.Query(context.Background(), `SELECT f.id::text,f.status,f.created_at,s.id::text,s.email,s.name,s.avatar_url,s.created_at,r.id::text,r.email,r.name,r.avatar_url,r.created_at FROM friend_requests f JOIN users s ON s.id=f.sender_id JOIN users r ON r.id=f.receiver_id WHERE (f.sender_id=$1 OR f.receiver_id=$1) AND f.status='pending'`, uid)
	if e != nil {
		return nil, nil, e
	}
	defer rows.Close()
	reqs := []FriendRequest{}
	for rows.Next() {
		var f FriendRequest
		if e = rows.Scan(&f.ID, &f.Status, &f.CreatedAt, &f.Sender.ID, &f.Sender.Email, &f.Sender.Name, &f.Sender.AvatarURL, &f.Sender.CreatedAt, &f.Receiver.ID, &f.Receiver.Email, &f.Receiver.Name, &f.Receiver.AvatarURL, &f.Receiver.CreatedAt); e != nil {
			return nil, nil, e
		}
		reqs = append(reqs, f)
	}
	return friends, reqs, rows.Err()
}
func (s *PostgresStore) CreateFriendRequest(a, b string) (FriendRequest, error) {
	var id string
	var t time.Time
	e := s.DB.QueryRow(context.Background(), `INSERT INTO friend_requests(sender_id,receiver_id) VALUES($1,$2) RETURNING id::text,created_at`, a, b).Scan(&id, &t)
	if e != nil {
		return FriendRequest{}, e
	}
	au, e := s.UserByID(a)
	if e != nil {
		return FriendRequest{}, e
	}
	bu, e := s.UserByID(b)
	return FriendRequest{ID: id, Sender: au, Receiver: bu, Status: "pending", CreatedAt: t}, e
}
func (s *PostgresStore) AcceptFriendRequest(id, uid string) error {
	tag, e := s.DB.Exec(context.Background(), `UPDATE friend_requests SET status='accepted',updated_at=now() WHERE id=$1 AND receiver_id=$2 AND status='pending'`, id, uid)
	if e == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return e
}
func (s *PostgresStore) DeleteFriendship(a, b string) error {
	_, e := s.DB.Exec(context.Background(), `DELETE FROM friend_requests WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)`, a, b)
	return e
}
