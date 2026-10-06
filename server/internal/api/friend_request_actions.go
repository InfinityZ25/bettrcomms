package api

import (
	"context"
	"net/http"
	"strings"
	"time"
)

type PendingFriendRequestStore interface {
	CancelPendingFriendRequest(requestID, userID string) (string, error)
}

// Cancellation has a request identity and a pending-state precondition. It
// cannot accidentally remove an accepted friendship after another device acts.
func (s *PostgresStore) CancelPendingFriendRequest(request, user string) (string, error) {
	ctx := context.Background()
	var sender, receiver string
	err := s.DB.QueryRow(ctx, `SELECT sender_id::text,receiver_id::text FROM friend_requests WHERE id=$1 AND status='pending' AND (sender_id=$2 OR receiver_id=$2)`, request, user).Scan(&sender, &receiver)
	if err != nil {
		return "", norm(err)
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, directPairKey(sender, receiver)); err != nil {
		return "", err
	}
	var other string
	err = tx.QueryRow(ctx, `DELETE FROM friend_requests WHERE id=$1 AND status='pending' AND (sender_id=$2 OR receiver_id=$2) RETURNING CASE WHEN sender_id=$2 THEN receiver_id ELSE sender_id END::text`, request, user).Scan(&other)
	if err != nil {
		return "", norm(err)
	}
	return other, tx.Commit(ctx)
}

func (a *API) declineFriendRequest(w http.ResponseWriter, r *http.Request, u User, path string) {
	parts := strings.Split(path, "/")
	if len(parts) != 4 || parts[3] != "decline" || !uuidPattern.MatchString(parts[2]) {
		a.fail(w, 404, "not_found", "friend request not found")
		return
	}
	store, ok := a.Store.(PendingFriendRequestStore)
	if !ok {
		a.fail(w, 503, "unavailable", "friend request actions unavailable")
		return
	}
	if !a.limiter.allow("friend-request-action:"+u.ID, 60, time.Minute) {
		a.fail(w, 429, "rate_limited", "too many friend request actions")
		return
	}
	other, err := store.CancelPendingFriendRequest(strings.ToLower(parts[2]), u.ID)
	if err == nil {
		a.Realtime.publishUser(u.ID, wire{Type: "friends.changed"})
		a.Realtime.publishUser(other, wire{Type: "friends.changed"})
	}
	a.result(w, map[string]bool{"ok": true}, err)
}
