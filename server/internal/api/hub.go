package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"sort"
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
	Muted       *bool           `json:"muted,omitempty"`
	Deafened    *bool           `json:"deafened,omitempty"`
}
type client struct {
	user string
	name string
	conn *websocket.Conn
	send chan wire
}
type Hub struct {
	mu       sync.RWMutex
	rooms    map[string]map[*client]struct{}
	voices   map[string]map[string]*voiceClient
	presence map[string]map[string]CallParticipant
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]map[*client]struct{}{}, voices: map[string]map[string]*voiceClient{}, presence: map[string]map[string]CallParticipant{}}
}
func (h *Hub) add(room string, c *client) []string {
	h.mu.Lock()
	if h.rooms[room] == nil {
		h.rooms[room] = map[*client]struct{}{}
	}
	var replaced []*client
	var replacedVoices []*voiceClient
	peers := make([]string, 0, len(h.rooms[room]))
	for existing := range h.rooms[room] {
		if existing.user == c.user {
			replaced = append(replaced, existing)
			if voice := h.voices[room][existing.user]; voice != nil && voice.owner == existing {
				replacedVoices = append(replacedVoices, voice)
				delete(h.voices[room], existing.user)
			}
			delete(h.rooms[room], existing)
		} else {
			peers = append(peers, existing.user)
		}
	}
	h.rooms[room][c] = struct{}{}
	if h.presence[room] == nil {
		h.presence[room] = map[string]CallParticipant{}
	}
	h.presence[room][c.user] = CallParticipant{UserID: c.user, Name: c.name, Muted: true}
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
	for _, voice := range replacedVoices {
		voice.close("signaling connection replaced")
	}
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
	var voice *voiceClient
	if candidate := h.voices[room][c.user]; candidate != nil && candidate.owner == c {
		voice = candidate
		delete(h.voices[room], c.user)
	}
	userStillConnected := false
	for existing := range h.rooms[room] {
		if existing.user == c.user {
			userStillConnected = true
			break
		}
	}
	if len(h.rooms[room]) == 0 {
		delete(h.rooms, room)
		delete(h.voices, room)
	}
	if !userStillConnected {
		delete(h.presence[room], c.user)
	}
	if len(h.presence[room]) == 0 {
		delete(h.presence, room)
	}
	h.mu.Unlock()
	if voice != nil {
		voice.close("signaling connection closed")
	}
	if !userStillConnected {
		h.broadcast(room, c, wire{Type: "peer.left", From: c.user})
	}
}

type CallParticipant struct {
	UserID   string `json:"user_id"`
	Name     string `json:"name,omitempty"`
	Muted    bool   `json:"muted"`
	Deafened bool   `json:"deafened"`
}

type RoomCallPresence struct {
	RoomID       string            `json:"room_id"`
	Participants []CallParticipant `json:"participants"`
}

func (h *Hub) setPresence(room string, sender *client, muted, deafened bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, active := h.rooms[room][sender]; !active {
		return false
	}
	if h.presence[room] == nil {
		return false
	}
	if _, connected := h.presence[room][sender.user]; !connected {
		return false
	}
	participant := h.presence[room][sender.user]
	participant.Muted = muted
	participant.Deafened = deafened
	h.presence[room][sender.user] = participant
	return true
}

func (h *Hub) callPresence(room string) []CallParticipant {
	h.mu.RLock()
	defer h.mu.RUnlock()
	participants := make([]CallParticipant, 0, len(h.presence[room]))
	for _, participant := range h.presence[room] {
		participants = append(participants, participant)
	}
	sort.Slice(participants, func(i, j int) bool { return participants[i].UserID < participants[j].UserID })
	return participants
}

func decodePresence(payload json.RawMessage) (muted, deafened bool, err error) {
	var presence struct {
		Microphone *bool `json:"microphone"`
		Muted      *bool `json:"muted"`
		Deafened   *bool `json:"deafened"`
	}
	if len(payload) == 0 || json.Unmarshal(payload, &presence) != nil || (presence.Microphone == nil && presence.Muted == nil && presence.Deafened == nil) {
		return false, false, errors.New("presence requires boolean microphone, muted, or deafened state")
	}
	muted = true
	if presence.Microphone != nil {
		muted = !*presence.Microphone
	}
	if presence.Muted != nil {
		muted = *presence.Muted
	}
	deafened = presence.Deafened != nil && *presence.Deafened
	if deafened {
		muted = true
	}
	return muted, deafened, nil
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
	h.mu.Lock()
	targets := []*client{}
	for c := range h.rooms[room] {
		if c.user == user {
			targets = append(targets, c)
		}
	}
	voice := h.voices[room][user]
	delete(h.voices[room], user)
	delete(h.presence[room], user)
	h.mu.Unlock()
	if voice != nil {
		voice.close("room membership revoked")
	}
	for _, c := range targets {
		go func(target *client) {
			_ = target.conn.Close(websocket.StatusPolicyViolation, "room membership revoked")
		}(c)
	}
}
func (h *Hub) disconnectRoom(room string) {
	h.mu.Lock()
	targets := []*client{}
	voices := []*voiceClient{}
	for c := range h.rooms[room] {
		targets = append(targets, c)
	}
	for _, voice := range h.voices[room] {
		voices = append(voices, voice)
	}
	delete(h.voices, room)
	delete(h.presence, room)
	h.mu.Unlock()
	for _, voice := range voices {
		voice.close("room deleted")
	}
	for _, c := range targets {
		go func(target *client) { _ = target.conn.Close(websocket.StatusPolicyViolation, "room deleted") }(c)
	}
}
func (h *Hub) disconnectUser(user string) {
	h.mu.Lock()
	targets := []*client{}
	voices := []*voiceClient{}
	for room, clients := range h.rooms {
		for c := range clients {
			if c.user == user {
				targets = append(targets, c)
			}
		}
		if voice := h.voices[room][user]; voice != nil {
			voices = append(voices, voice)
			delete(h.voices[room], user)
			if len(h.voices[room]) == 0 {
				delete(h.voices, room)
			}
		}
		delete(h.presence[room], user)
	}
	h.mu.Unlock()
	for _, voice := range voices {
		voice.close("session revoked")
	}
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
	c := &client{user: u.ID, name: u.Name, conn: conn, send: make(chan wire, 32)}
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
		readContext, readCancel := context.WithTimeout(ctx, 45*time.Second)
		e := wsjsonRead(readContext, conn, &m)
		readCancel()
		if e != nil {
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
			muted, deafened, presenceError := decodePresence(m.Payload)
			if presenceError != nil {
				select {
				case c.send <- wire{Type: "error", Error: &apiError{Code: "invalid_presence", Message: presenceError.Error()}}:
				default:
				}
				continue
			}
			if !a.Hub.setPresence(room, c, muted, deafened) {
				return
			}
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
