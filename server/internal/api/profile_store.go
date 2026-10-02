package api

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

type ProfileUpdate struct{ Name, Username, Bio *string }

type ProfileStore interface {
	UpdateProfile(string, ProfileUpdate) (User, error)
	SetAvatar(string, []byte) (User, error)
	Avatar(string, string) ([]byte, error)
	Presence(string) (string, error)
	SetPresence(string, string) error
	ContactPresence([]string) (map[string]string, error)
}

var ErrUsernameTaken = errors.New("username taken")

func (s *PostgresStore) UpdateProfile(id string, update ProfileUpdate) (User, error) {
	u, err := scanUser(s.DB.QueryRow(context.Background(), `UPDATE users SET
 name=COALESCE($2,name),username=COALESCE($3,username),bio=COALESCE($4,bio),
 profile_edited=true,profile_version=profile_version+1,updated_at=now() WHERE id=$1 RETURNING `+userCols, id, update.Name, update.Username, update.Bio))
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "users_username_unique" {
		return User{}, ErrUsernameTaken
	}
	return u, err
}

func (s *PostgresStore) SetAvatar(id string, data []byte) (User, error) {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback(ctx)
	var version int64
	if err = tx.QueryRow(ctx, `UPDATE users SET avatar_version=avatar_version+1,profile_version=profile_version+1,avatar_edited=true,updated_at=now() WHERE id=$1 RETURNING avatar_version`, id).Scan(&version); err != nil {
		return User{}, norm(err)
	}
	var path *string
	if len(data) > 0 {
		value := fmt.Sprintf("/api/v1/users/%s/avatar?version=%d", id, version)
		path = &value
		_, err = tx.Exec(ctx, `INSERT INTO user_avatars(user_id,image) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET image=EXCLUDED.image`, id, data)
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM user_avatars WHERE user_id=$1`, id)
	}
	if err != nil {
		return User{}, err
	}
	u, err := scanUser(tx.QueryRow(ctx, `UPDATE users SET avatar_url=$2 WHERE id=$1 RETURNING `+userCols, id, path))
	if err != nil {
		return User{}, err
	}
	return u, tx.Commit(ctx)
}

func (s *PostgresStore) Avatar(target, viewer string) ([]byte, error) {
	var image []byte
	err := s.DB.QueryRow(context.Background(), `SELECT a.image FROM user_avatars a WHERE a.user_id=$1 AND (
 $1=$2 OR (NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=$2) OR (b.blocker_id=$2 AND b.blocked_id=$1)) AND (
 EXISTS(SELECT 1 FROM friend_requests f WHERE (f.sender_id=$1 AND f.receiver_id=$2) OR (f.sender_id=$2 AND f.receiver_id=$1)) OR
 EXISTS(SELECT 1 FROM room_members mine JOIN room_members theirs ON theirs.room_id=mine.room_id WHERE mine.user_id=$2 AND theirs.user_id=$1 AND can_access_room(mine.room_id,$2)))))`, target, viewer).Scan(&image)
	return image, norm(err)
}
func (s *PostgresStore) Presence(id string) (string, error) {
	var status string
	err := s.DB.QueryRow(context.Background(), `SELECT presence_status FROM users WHERE id=$1`, id).Scan(&status)
	return status, norm(err)
}
func (s *PostgresStore) SetPresence(id, status string) error {
	ctx := context.Background()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE users SET presence_status=$2,updated_at=now() WHERE id=$1`, id, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if status == "dnd" {
		_, err = tx.Exec(ctx, `DELETE FROM push_deliveries WHERE subscription_id IN(SELECT id FROM push_subscriptions WHERE user_id=$1)`, id)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) ContactPresence(ids []string) (map[string]string, error) {
	rows, err := s.DB.Query(context.Background(), `SELECT id::text,presence_status FROM users WHERE id=ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := map[string]string{}
	for rows.Next() {
		var id, status string
		if err = rows.Scan(&id, &status); err != nil {
			return nil, err
		}
		values[id] = status
	}
	return values, rows.Err()
}
