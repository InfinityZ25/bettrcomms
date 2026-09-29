package api

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type DMRequest struct {
	ID           string    `json:"id"`
	SenderID     string    `json:"sender_id"`
	SenderName   string    `json:"sender_name"`
	ReceiverID   string    `json:"receiver_id"`
	ReceiverName string    `json:"receiver_name"`
	Body         string    `json:"body"`
	CreatedAt    time.Time `json:"created_at"`
}

func directPairKey(left, right string) string {
	if right < left {
		left, right = right, left
	}
	return left + ":" + right
}

func (s *PostgresStore) DMPrivacy(user string) (bool, []User, error) {
	ctx := context.Background()
	var allow bool
	if err := s.DB.QueryRow(ctx, `SELECT allow_dm_requests FROM users WHERE id=$1`, user).Scan(&allow); err != nil {
		return false, nil, norm(err)
	}
	rows, err := s.DB.Query(ctx, `SELECT u.id::text,u.email,u.name,u.avatar_url,u.created_at FROM user_blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=$1 ORDER BY u.name`, user)
	if err != nil {
		return false, nil, err
	}
	defer rows.Close()
	blocked := []User{}
	for rows.Next() {
		var item User
		if err = rows.Scan(&item.ID, &item.Email, &item.Name, &item.AvatarURL, &item.CreatedAt); err != nil {
			return false, nil, err
		}
		blocked = append(blocked, item)
	}
	return allow, blocked, rows.Err()
}

func (s *PostgresStore) SetDMRequestsAllowed(user string, allowed bool) error {
	_, err := s.DB.Exec(context.Background(), `UPDATE users SET allow_dm_requests=$2,updated_at=now() WHERE id=$1`, user, allowed)
	return err
}

func (s *PostgresStore) BlockUser(user, target string) (string, error) {
	if user == target {
		return "", ErrForbidden
	}
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, directPairKey(user, target)); err != nil {
		return "", err
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)`, target).Scan(&exists); err != nil {
		return "", err
	}
	if !exists {
		return "", ErrNotFound
	}
	if _, err = tx.Exec(ctx, `INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, user, target); err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM friend_requests WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)`, user, target); err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `UPDATE dm_requests SET status='declined',updated_at=now() WHERE status IN ('pending','accepted') AND ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1))`, user, target); err != nil {
		return "", err
	}
	var room string
	err = tx.QueryRow(ctx, `SELECT id::text FROM rooms WHERE direct_key=$1`, directPairKey(user, target)).Scan(&room)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	return room, tx.Commit(ctx)
}

func (s *PostgresStore) UnblockUser(user, target string) error {
	_, err := s.DB.Exec(context.Background(), `DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2`, user, target)
	return err
}

func (s *PostgresStore) ListDMRequests(user string) ([]DMRequest, error) {
	rows, err := s.DB.Query(context.Background(), `SELECT d.id::text,d.sender_id::text,s.name,d.receiver_id::text,r.name,d.body,d.created_at FROM dm_requests d JOIN users s ON s.id=d.sender_id JOIN users r ON r.id=d.receiver_id WHERE d.status='pending' AND (d.sender_id=$1 OR d.receiver_id=$1) ORDER BY d.created_at DESC LIMIT 100`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	requests := []DMRequest{}
	for rows.Next() {
		var item DMRequest
		if err = rows.Scan(&item.ID, &item.SenderID, &item.SenderName, &item.ReceiverID, &item.ReceiverName, &item.Body, &item.CreatedAt); err != nil {
			return nil, err
		}
		requests = append(requests, item)
	}
	return requests, rows.Err()
}

func (s *PostgresStore) CreateDMRequest(sender, receiver, body string) (DMRequest, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return DMRequest{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, directPairKey(sender, receiver)); err != nil {
		return DMRequest{}, err
	}
	var item DMRequest
	err = tx.QueryRow(ctx, `INSERT INTO dm_requests(sender_id,receiver_id,body) SELECT $1,$2,$3 FROM users u WHERE u.id=$2 AND u.allow_dm_requests AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=$2) OR (b.blocker_id=$2 AND b.blocked_id=$1)) AND NOT EXISTS(SELECT 1 FROM friend_requests f WHERE f.status='accepted' AND ((f.sender_id=$1 AND f.receiver_id=$2) OR (f.sender_id=$2 AND f.receiver_id=$1))) AND NOT EXISTS(SELECT 1 FROM dm_requests d WHERE d.status IN ('pending','accepted') AND ((d.sender_id=$1 AND d.receiver_id=$2) OR (d.sender_id=$2 AND d.receiver_id=$1))) RETURNING id::text,created_at`, sender, receiver, strings.TrimSpace(body)).Scan(&item.ID, &item.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return item, ErrForbidden
	}
	if err != nil {
		return item, err
	}
	item.SenderID, item.ReceiverID, item.Body = sender, receiver, strings.TrimSpace(body)
	return item, tx.Commit(ctx)
}

func (s *PostgresStore) AcceptDMRequest(id, receiver string) (Room, Message, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Room{}, Message{}, err
	}
	defer tx.Rollback(ctx)
	var sender, body string
	err = tx.QueryRow(ctx, `SELECT sender_id::text FROM dm_requests WHERE id=$1 AND receiver_id=$2 AND status='pending'`, id, receiver).Scan(&sender)
	if err != nil {
		return Room{}, Message{}, norm(err)
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, directPairKey(sender, receiver)); err != nil {
		return Room{}, Message{}, err
	}
	err = tx.QueryRow(ctx, `SELECT sender_id::text,body FROM dm_requests WHERE id=$1 AND receiver_id=$2 AND status='pending' FOR UPDATE`, id, receiver).Scan(&sender, &body)
	if err != nil {
		return Room{}, Message{}, norm(err)
	}
	var blocked bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1))`, sender, receiver).Scan(&blocked); err != nil {
		return Room{}, Message{}, err
	}
	if blocked {
		return Room{}, Message{}, ErrForbidden
	}
	var roomID string
	err = tx.QueryRow(ctx, `INSERT INTO rooms(name,owner_id,kind,direct_key) VALUES('Direct message',$1,'direct',$2) ON CONFLICT(direct_key) WHERE direct_key IS NOT NULL DO UPDATE SET direct_key=EXCLUDED.direct_key RETURNING id::text`, receiver, directPairKey(sender, receiver)).Scan(&roomID)
	if err != nil {
		return Room{}, Message{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member') ON CONFLICT DO NOTHING`, roomID, receiver, sender); err != nil {
		return Room{}, Message{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE dm_requests SET status='accepted',updated_at=now() WHERE id=$1`, id); err != nil {
		return Room{}, Message{}, err
	}
	var messageID string
	if err = tx.QueryRow(ctx, `INSERT INTO messages(room_id,author_id,body) VALUES($1,$2,$3) RETURNING id::text`, roomID, sender, body).Scan(&messageID); err != nil {
		return Room{}, Message{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO push_deliveries(message_id,subscription_id) SELECT $1,id FROM push_subscriptions WHERE user_id=$2 AND NOT dnd ON CONFLICT DO NOTHING`, messageID, receiver); err != nil {
		return Room{}, Message{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Room{}, Message{}, err
	}
	room, err := s.RoomForMember(roomID, receiver)
	if err != nil {
		return Room{}, Message{}, err
	}
	message, err := s.MessageByID(roomID, messageID)
	return room, message, err
}

func (s *PostgresStore) DeclineDMRequest(id, user string) (string, error) {
	var other string
	err := s.DB.QueryRow(context.Background(), `UPDATE dm_requests SET status='declined',updated_at=now() WHERE id=$1 AND status='pending' AND (sender_id=$2 OR receiver_id=$2) RETURNING CASE WHEN sender_id=$2 THEN receiver_id::text ELSE sender_id::text END`, id, user).Scan(&other)
	return other, norm(err)
}
