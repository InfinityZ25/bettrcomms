package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type sfuClaims struct {
	RoomID    string `json:"room_id"`
	UserID    string `json:"user_id"`
	PeerID    string `json:"peer_id"`
	SessionID string `json:"session_id"`
	Exp       int64  `json:"exp"`
}
type sfuLease struct {
	room, user, peer, session string
	conn                      *websocket.Conn
}

func (a *API) verifySFUClaims(token string) (sfuClaims, bool) {
	var claims sfuClaims
	if a.Config.SFUJoinSecret == "" || len(token) > 8192 {
		return claims, false
	}
	payload, signature, ok := strings.Cut(token, ".")
	if !ok {
		return claims, false
	}
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return claims, false
	}
	mac := hmac.New(sha256.New, []byte(a.Config.SFUJoinSecret))
	mac.Write([]byte(payload))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return claims, false
	}
	body, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil || json.Unmarshal(body, &claims) != nil {
		return claims, false
	}
	return claims, claims.Exp > time.Now().Unix() && uuidPattern.MatchString(claims.RoomID) && uuidPattern.MatchString(claims.UserID) && uuidPattern.MatchString(claims.PeerID) && uuidPattern.MatchString(claims.SessionID)
}

// The media server holds one authorization socket per live peer. Losing this
// lease tears down SFU media, including on API restart or a network partition.
// There is no per-frame database check and no revocation polling.
func (a *API) sfuAuthorization(w http.ResponseWriter, r *http.Request) {
	claims, ok := a.verifySFUClaims(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if !ok {
		a.fail(w, 401, "invalid_sfu_authorization", "invalid or expired SFU authorization")
		return
	}
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "SFU authorization unavailable")
		return
	}
	a.accessMu.RLock()
	registering := true
	defer func() {
		if registering {
			a.accessMu.RUnlock()
		}
	}()
	var expires time.Time
	err := store.DB.QueryRow(r.Context(), `SELECT s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.expires_at>now() AND u.deleted_at IS NULL AND room_has_permission($3,$2,'join_voice')`, claims.SessionID, claims.UserID, claims.RoomID).Scan(&expires)
	if err != nil {
		a.fail(w, 403, "sfu_access_revoked", "session or room access was revoked")
		return
	}
	owner := a.Hub.activeSignal(claims.RoomID, claims.UserID, claims.PeerID)
	if owner == nil || owner.session != claims.SessionID {
		a.fail(w, 403, "signaling_required", "SFU requires this session's active signaling peer")
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: a.AllowedOrigins})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1024)
	lease := &sfuLease{room: claims.RoomID, user: claims.UserID, peer: claims.PeerID, session: claims.SessionID, conn: conn}
	a.sfuMu.Lock()
	if a.sfuLeases == nil {
		a.sfuLeases = map[*sfuLease]struct{}{}
	}
	if len(a.sfuLeases) >= 4096 {
		a.sfuMu.Unlock()
		_ = conn.Close(websocket.StatusTryAgainLater, "SFU authorization capacity reached")
		return
	}
	for old := range a.sfuLeases {
		if old.room == lease.room && old.peer == lease.peer {
			a.sfuMu.Unlock()
			_ = conn.Close(websocket.StatusTryAgainLater, "peer authorization is already active")
			return
		}
	}
	a.sfuLeases[lease] = struct{}{}
	a.sfuMu.Unlock()
	defer func() { a.sfuMu.Lock(); delete(a.sfuLeases, lease); a.sfuMu.Unlock() }()
	readyCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	err = wsjsonWrite(readyCtx, conn, map[string]bool{"authorized": true})
	cancel()
	if err != nil {
		return
	}
	a.accessMu.RUnlock()
	registering = false
	timer := time.AfterFunc(time.Until(expires), func() { _ = conn.Close(websocket.StatusPolicyViolation, "session expired") })
	defer timer.Stop()
	for {
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		kind, body, err := conn.Read(ctx)
		if err == nil && kind == websocket.MessageText && string(body) == "ping" {
			err = conn.Write(ctx, websocket.MessageText, []byte("pong"))
		} else if err == nil {
			cancel()
			return
		}
		cancel()
		if err != nil {
			return
		}
	}
}
func (a *API) revokeSFU(room, user, session string) {
	a.sfuMu.Lock()
	targets := []*sfuLease{}
	for lease := range a.sfuLeases {
		if (room == "" || lease.room == room) && (user == "" || lease.user == user) && (session == "" || lease.session == session) {
			delete(a.sfuLeases, lease)
			targets = append(targets, lease)
		}
	}
	a.sfuMu.Unlock()
	for _, lease := range targets {
		go lease.conn.Close(websocket.StatusPolicyViolation, "SFU access revoked")
	}
}
