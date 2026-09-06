package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type wire struct {
	Type        string          `json:"type"`
	To          string          `json:"to,omitempty"`
	From        string          `json:"from,omitempty"`
	RequestID   string          `json:"request_id,omitempty"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	Description json.RawMessage `json:"description,omitempty"`
	Candidate   json.RawMessage `json:"candidate,omitempty"`
	Tracks      json.RawMessage `json:"tracks,omitempty"`
	Transport   string          `json:"transport,omitempty"`
	CaptureID   string          `json:"captureId,omitempty"`
	Data        json.RawMessage `json:"data,omitempty"`
	Error       *apiError       `json:"error,omitempty"`
}
type client struct {
	user string
	conn *websocket.Conn
	send chan wire
}
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[*client]struct{}
}

func NewHub() *Hub { return &Hub{rooms: map[string]map[*client]struct{}{}} }
func (h *Hub) add(room string, c *client) []string {
	h.mu.Lock()
	if h.rooms[room] == nil {
		h.rooms[room] = map[*client]struct{}{}
	}
	var replaced []*client
	peers := make([]string, 0, len(h.rooms[room]))
	for existing := range h.rooms[room] {
		if existing.user == c.user {
			replaced = append(replaced, existing)
			delete(h.rooms[room], existing)
		} else {
			peers = append(peers, existing.user)
		}
	}
	h.rooms[room][c] = struct{}{}
	// Snapshot and membership must be atomic. Otherwise simultaneous callers
	// can both receive an empty snapshot and only one learns the other exists.
	if len(replaced) == 0 {
		for existing := range h.rooms[room] {
			if existing != c {
				select {
				case existing.send <- wire{Type: "peer.joined", From: c.user}:
				default:
				}
			}
		}
	}
	h.mu.Unlock()
	for _, existing := range replaced {
		go func(old *client) {
			_ = old.conn.Close(websocket.StatusPolicyViolation, "replaced by a newer connection")
		}(existing)
	}
	return peers
}
func (h *Hub) remove(room string, c *client) {
	h.mu.Lock()
	delete(h.rooms[room], c)
	userStillConnected := false
	for existing := range h.rooms[room] {
		if existing.user == c.user {
			userStillConnected = true
			break
		}
	}
	if len(h.rooms[room]) == 0 {
		delete(h.rooms, room)
	}
	h.mu.Unlock()
	if !userStillConnected {
		h.broadcast(room, c, wire{Type: "peer.left", From: c.user})
	}
}
func (h *Hub) broadcast(room string, skip *client, m wire) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[room] {
		if c != skip {
			select {
			case c.send <- m:
			default:
			}
		}
	}
}
func (h *Hub) relay(room, to string, m wire) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ok := false
	for c := range h.rooms[room] {
		if c.user == to {
			select {
			case c.send <- m:
				ok = true
			default:
			}
		}
	}
	return ok
}
func (h *Hub) peers(room, user string) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	seen := map[string]bool{}
	out := []string{}
	for c := range h.rooms[room] {
		if c.user != user && !seen[c.user] {
			seen[c.user] = true
			out = append(out, c.user)
		}
	}
	return out
}
func (h *Hub) disconnectRoomUser(room, user string) {
	h.mu.RLock()
	targets := []*client{}
	for c := range h.rooms[room] {
		if c.user == user {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range targets {
		go func(target *client) {
			_ = target.conn.Close(websocket.StatusPolicyViolation, "room membership revoked")
		}(c)
	}
}
func (h *Hub) disconnectRoom(room string) {
	h.mu.RLock()
	targets := []*client{}
	for c := range h.rooms[room] {
		targets = append(targets, c)
	}
	h.mu.RUnlock()
	for _, c := range targets {
		go func(target *client) { _ = target.conn.Close(websocket.StatusPolicyViolation, "room deleted") }(c)
	}
}
func (h *Hub) disconnectUser(user string) {
	h.mu.RLock()
	targets := []*client{}
	for _, clients := range h.rooms {
		for c := range clients {
			if c.user == user {
				targets = append(targets, c)
			}
		}
	}
	h.mu.RUnlock()
	for _, c := range targets {
		go func(target *client) { _ = target.conn.Close(websocket.StatusPolicyViolation, "session revoked") }(c)
	}
}
func (a *API) websocket(w http.ResponseWriter, r *http.Request, u User, room string) {
	if _, e := a.Store.RoomForMember(room, u.ID); e != nil {
		a.fail(w, http.StatusForbidden, "not_a_member", "room membership required")
		return
	}
	if !a.websocketOriginAllowed(r) {
		a.fail(w, http.StatusForbidden, "origin_not_allowed", "WebSocket origin is not allowed")
		return
	}
	conn, e := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: a.AllowedOrigins})
	if e != nil {
		return
	}
	conn.SetReadLimit(64 << 10)
	c := &client{user: u.ID, conn: conn, send: make(chan wire, 32)}
	initialPeers := a.Hub.add(room, c)
	defer func() { a.Hub.remove(room, c); conn.CloseNow() }()
	peers, _ := json.Marshal(map[string]any{"peers": initialPeers})
	if e = wsjsonWrite(r.Context(), conn, wire{Type: "peers", Payload: peers}); e != nil {
		conn.CloseNow()
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		for {
			var m wire
			select {
			case <-ctx.Done():
				return
			case m = <-c.send:
			}
			wc, wcancel := context.WithTimeout(ctx, 5*time.Second)
			e := wsjsonWrite(wc, conn, m)
			wcancel()
			if e != nil {
				cancel()
				return
			}
		}
	}()
	for {
		var m wire
		if e := wsjsonRead(ctx, conn, &m); e != nil {
			return
		}
		switch m.Type {
		case "ping":
			if m.RequestID == "" || len(m.RequestID) > 128 {
				select {
				case c.send <- wire{Type: "error", Error: &apiError{Code: "invalid_ping", Message: "request_id must contain 1-128 bytes"}}:
				default:
				}
				continue
			}
			select {
			case c.send <- wire{Type: "pong", RequestID: m.RequestID}:
			default:
			}
		case "presence":
			m.From = u.ID
			a.Hub.broadcast(room, c, m)
		case "signal", "offer", "answer", "ice-candidate", "track-metadata":
			if m.To == "" {
				select {
				case c.send <- wire{Type: "error", Error: &apiError{Code: "missing_target", Message: "to is required"}}:
				default:
				}
				continue
			}
			m.From = u.ID
			if !a.Hub.relay(room, m.To, m) {
				select {
				case c.send <- wire{Type: "error", RequestID: m.RequestID, Error: &apiError{Code: "peer_unavailable", Message: "target is not connected"}}:
				default:
				}
			}
		default:
			select {
			case c.send <- wire{Type: "error", Error: &apiError{Code: "invalid_type", Message: "unsupported message type"}}:
			default:
			}
		}
	}
}
func (a *API) websocketOriginAllowed(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return false
	}
	got, e := url.Parse(o)
	if e != nil {
		return false
	}
	if a.Config.DevAuth && (got.Scheme == "http" || got.Scheme == "https") && (got.Hostname() == "localhost" || net.ParseIP(got.Hostname()).IsLoopback()) {
		return true
	}
	if a.Config.AppURL != "" {
		want, e := url.Parse(a.Config.AppURL)
		return e == nil && strings.EqualFold(got.Scheme, want.Scheme) && strings.EqualFold(got.Host, want.Host)
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return strings.EqualFold(got.Scheme, scheme) && strings.EqualFold(got.Host, r.Host)
}
func wsjsonRead(ctx context.Context, c *websocket.Conn, v any) error {
	_, b, e := c.Read(ctx)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, v)
}
func wsjsonWrite(ctx context.Context, c *websocket.Conn, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return c.Write(ctx, websocket.MessageText, b)
}
