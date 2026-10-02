package api

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
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
	UserID      string          `json:"user_id,omitempty"`
	Name        string          `json:"name,omitempty"`
}
type client struct {
	session  string
	revoked  atomic.Bool
	peer     string
	user     string
	name     string
	conn     *websocket.Conn
	send     chan wire
	muted    bool
	deafened bool
	// overflowed is set once this client's queue has been full.
	overflowed atomic.Bool
	// relayBudget limits what this client may send to others. It is only
	// touched by this client's own read loop.
	relayBudget relayBudget
}

// relayBudget is a token bucket for one connection's relayed signaling.
//
// A full queue disconnects its recipient so that it resynchronises, which
// would let one room member knock another off a call by flooding them. The
// burst covers a full call's setup (an offer or answer and a dozen or more
// candidates per peer, for the call and each native sender); the refill is
// far below what a healthy recipient drains, so only a sender that floods is
// held back, and only that sender's excess is refused.
type relayBudget struct {
	tokens float64
	last   time.Time
}

const (
	relayBurst     = 400
	relayPerSecond = 100
)

func (b *relayBudget) allow(now time.Time) bool {
	if b.last.IsZero() {
		b.tokens = relayBurst
	} else {
		b.tokens = math.Min(relayBurst, b.tokens+now.Sub(b.last).Seconds()*relayPerSecond)
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// signalQueue is how many messages may wait for one client. A new call sends
// a burst: every peer's offer or answer and a dozen or more ICE candidates
// each, for the call connection and again for each native video sender.
const signalQueue = 256

// deliver queues m without blocking, since callers hold the hub lock.
//
// A full queue means the client has stopped reading. Dropping the message
// used to be silent, and a lost peer.joined, offer, answer or candidate left
// a pair of participants who never connected or a share that never appeared,
// with nothing to repair it. The connection is closed instead: the client
// reconnects and receives a fresh snapshot of the room.
func (c *client) deliver(m wire) bool {
	if c.revoked.Load() {
		return false
	}
	select {
	case c.send <- m:
		return true
	default:
	}
	if c.overflowed.CompareAndSwap(false, true) && c.conn != nil {
		go func() { _ = c.conn.Close(websocket.StatusTryAgainLater, "signaling queue overflowed") }()
	}
	return false
}

type Hub struct {
	mu     sync.RWMutex
	rooms  map[string]map[*client]struct{}
	voices map[string]map[string]*voiceClient
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]map[*client]struct{}{}, voices: map[string]map[string]*voiceClient{}}
}
func (h *Hub) add(room string, c *client) []string {
	if c.peer == "" {
		c.peer = c.user
	}
	c.muted = true
	peers, _, _ := h.addWithMode(room, c, true)
	return peers
}

func (h *Hub) addWithMode(room string, c *client, replaceUser bool) ([]string, map[string]PeerIdentity, error) {
	h.mu.Lock()
	if h.rooms[room] == nil {
		h.rooms[room] = map[*client]struct{}{}
	}
	var replaced []*client
	var replacedVoices []*voiceClient
	// The same participant reconnecting its signaling socket keeps its peer
	// connections and its media. Announcing that as a departure and a fresh
	// arrival would make everyone else tear those connections down and rebuild
	// them, which is exactly the interruption reconnecting exists to avoid.
	resumed := false
	for existing := range h.rooms[room] {
		if existing.peer == c.peer && existing.user != c.user {
			h.mu.Unlock()
			return nil, nil, errors.New("peer identity is already in use")
		}
		if existing.peer == c.peer || (replaceUser && existing.user == c.user) {
			existing.revoked.Store(true)
			if existing.peer == c.peer && existing.user == c.user {
				resumed = true
			}
			replaced = append(replaced, existing)
			if voice := h.voices[room][existing.peer]; voice != nil && voice.owner == existing {
				replacedVoices = append(replacedVoices, voice)
				delete(h.voices[room], existing.peer)
			}
			delete(h.rooms[room], existing)
		}
	}
	peers := make([]string, 0, len(h.rooms[room]))
	identities := make(map[string]PeerIdentity, len(h.rooms[room]))
	for existing := range h.rooms[room] {
		peers = append(peers, existing.peer)
		identities[existing.peer] = PeerIdentity{UserID: existing.user, Name: existing.name}
		for _, old := range replaced {
			if old.peer == c.peer && old.user == c.user {
				continue
			}
			existing.deliver(wire{Type: "peer.left", From: old.peer, UserID: old.user, Name: old.name})
		}
	}
	h.rooms[room][c] = struct{}{}
	// Snapshot and membership must be atomic. Otherwise simultaneous callers
	// can both receive an empty snapshot and only one learns the other exists.
	if !resumed {
		for existing := range h.rooms[room] {
			if existing != c {
				existing.deliver(wire{Type: "peer.joined", From: c.peer, UserID: c.user, Name: c.name})
			}
		}
	}
	h.mu.Unlock()
	for _, voice := range replacedVoices {
		voice.close("signaling connection replaced")
	}
	for _, existing := range replaced {
		go func(old *client) {
			if old.conn != nil {
				_ = old.conn.Close(websocket.StatusPolicyViolation, "replaced by a newer connection")
			}
		}(existing)
	}
	return peers, identities, nil
}
func (h *Hub) remove(room string, c *client) {
	h.mu.Lock()
	if _, active := h.rooms[room][c]; !active {
		h.mu.Unlock()
		return
	}
	delete(h.rooms[room], c)
	var voice *voiceClient
	if candidate := h.voices[room][c.peer]; candidate != nil && candidate.owner == c {
		voice = candidate
		delete(h.voices[room], c.peer)
	}
	if len(h.rooms[room]) == 0 {
		delete(h.rooms, room)
		delete(h.voices, room)
	}
	h.mu.Unlock()
	if voice != nil {
		voice.close("signaling connection closed")
	}
	h.broadcast(room, c, wire{Type: "peer.left", From: c.peer, UserID: c.user, Name: c.name})
}

type PeerIdentity struct {
	UserID string `json:"user_id"`
	Name   string `json:"name,omitempty"`
}

type CallParticipant struct {
	UserID      string `json:"user_id"`
	Name        string `json:"name,omitempty"`
	Muted       bool   `json:"muted"`
	Deafened    bool   `json:"deafened"`
	DeviceCount int    `json:"device_count"`
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
	sender.muted = muted
	sender.deafened = deafened
	return true
}

func (h *Hub) callPresence(room string) []CallParticipant {
	h.mu.RLock()
	defer h.mu.RUnlock()
	byUser := map[string]CallParticipant{}
	for c := range h.rooms[room] {
		if c.revoked.Load() {
			continue
		}
		participant, ok := byUser[c.user]
		if !ok {
			participant = CallParticipant{UserID: c.user, Name: c.name, Muted: true, Deafened: true}
		}
		participant.DeviceCount++
		participant.Muted = participant.Muted && c.muted
		participant.Deafened = participant.Deafened && c.deafened
		byUser[c.user] = participant
	}
	participants := make([]CallParticipant, 0, len(byUser))
	for _, participant := range byUser {
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
			c.deliver(m)
		}
	}
}
func (h *Hub) relay(room, to string, m wire) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ok := false
	for c := range h.rooms[room] {
		if c.peer == to {
			if c.deliver(m) {
				ok = true
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
		if c.user != user && !seen[c.peer] {
			seen[c.peer] = true
			out = append(out, c.peer)
		}
	}
	return out
}
func (h *Hub) disconnectRoomUser(room, user string) {
	h.mu.Lock()
	targets := []*client{}
	for c := range h.rooms[room] {
		if c.user == user {
			c.revoked.Store(true)
			targets = append(targets, c)
		}
	}
	voices := []*voiceClient{}
	for peer, voice := range h.voices[room] {
		if voice.user == user {
			voices = append(voices, voice)
			delete(h.voices[room], peer)
		}
	}
	h.mu.Unlock()
	for _, voice := range voices {
		voice.close("room membership revoked")
	}
	for _, c := range targets {
		h.remove(room, c)
		go func(target *client) {
			if target.conn != nil {
				_ = target.conn.Close(websocket.StatusPolicyViolation, "room membership revoked")
			}
		}(c)
	}
}
func (h *Hub) disconnectRoom(room string) {
	h.mu.Lock()
	targets := []*client{}
	voices := []*voiceClient{}
	for c := range h.rooms[room] {
		c.revoked.Store(true)
		targets = append(targets, c)
	}
	for _, voice := range h.voices[room] {
		voices = append(voices, voice)
	}
	delete(h.voices, room)
	delete(h.rooms, room)
	h.mu.Unlock()
	for _, voice := range voices {
		voice.close("room deleted")
	}
	for _, c := range targets {
		go func(target *client) {
			if target.conn != nil {
				_ = target.conn.Close(websocket.StatusPolicyViolation, "room deleted")
			}
		}(c)
	}
}
func (h *Hub) disconnectUser(user string) {
	type target struct {
		room string
		c    *client
	}
	h.mu.Lock()
	targets := []target{}
	voices := []*voiceClient{}
	for room, clients := range h.rooms {
		for c := range clients {
			if c.user == user {
				c.revoked.Store(true)
				targets = append(targets, target{room, c})
			}
		}
		for peer, voice := range h.voices[room] {
			if voice.user == user {
				voices = append(voices, voice)
				delete(h.voices[room], peer)
			}
		}
		if len(h.voices[room]) == 0 {
			delete(h.voices, room)
		}
	}
	h.mu.Unlock()
	for _, voice := range voices {
		voice.close("session revoked")
	}
	for _, item := range targets {
		h.remove(item.room, item.c)
		go func(c *client) {
			if c.conn != nil {
				_ = c.conn.Close(websocket.StatusPolicyViolation, "session revoked")
			}
		}(item.c)
	}
}
func (a *API) websocket(w http.ResponseWriter, r *http.Request, u User, room string) {
	a.accessMu.RLock()
	registering := true
	defer func() {
		if registering {
			a.accessMu.RUnlock()
		}
	}()
	session, authErr := a.Sessions.Resolve(r)
	if authErr != nil || session.UserID != u.ID {
		a.fail(w, 401, "unauthenticated", "sign in required")
		return
	}

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
	peerID := r.URL.Query().Get("peer_id")
	joinMode := r.URL.Query().Get("join_mode")
	if peerID == "" {
		peerID = u.ID
		joinMode = "replace"
	}
	if !uuidPattern.MatchString(peerID) || (joinMode != "" && joinMode != "replace" && joinMode != "additional") {
		_ = conn.Close(websocket.StatusPolicyViolation, "invalid peer identity or join mode")
		return
	}
	c := &client{session: session.ID, peer: peerID, user: u.ID, name: u.Name, conn: conn, send: make(chan wire, signalQueue), muted: true}
	if !session.ExpiresAt.IsZero() {
		timer := time.AfterFunc(time.Until(session.ExpiresAt), func() { c.revoked.Store(true); _ = conn.Close(websocket.StatusPolicyViolation, "session expired") })
		defer timer.Stop()
	}
	initialPeers, identities, addError := a.Hub.addWithMode(room, c, joinMode != "additional")
	if addError != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, addError.Error())
		return
	}
	a.publishCallPresence(room)
	defer func() { a.Hub.remove(room, c); a.publishCallPresence(room); conn.CloseNow() }()
	peers, _ := json.Marshal(map[string]any{"peers": initialPeers, "identities": identities})
	readyCtx, readyCancel := context.WithTimeout(r.Context(), 5*time.Second)
	e = wsjsonWrite(readyCtx, conn, wire{Type: "peers", Payload: peers})
	readyCancel()
	if e != nil {
		conn.CloseNow()
		return
	}
	a.accessMu.RUnlock()
	registering = false
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
			if c.revoked.Load() {
				cancel()
				return
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
		if c.revoked.Load() {
			return
		}
		switch m.Type {
		case "ping":
			if m.RequestID == "" || len(m.RequestID) > 128 {
				c.deliver(wire{Type: "error", Error: &apiError{Code: "invalid_ping", Message: "request_id must contain 1-128 bytes"}})
				continue
			}
			c.deliver(wire{Type: "pong", RequestID: m.RequestID})
		case "presence":
			muted, deafened, presenceError := decodePresence(m.Payload)
			if presenceError != nil {
				c.deliver(wire{Type: "error", Error: &apiError{Code: "invalid_presence", Message: presenceError.Error()}})
				continue
			}
			if !a.Hub.setPresence(room, c, muted, deafened) {
				return
			}
			a.publishCallPresence(room)
			m.From = c.peer
			m.UserID = c.user
			m.Name = c.name
			a.Hub.broadcast(room, c, m)
		case "signal", "offer", "answer", "ice-candidate", "track-metadata":
			if m.To == "" {
				c.deliver(wire{Type: "error", Error: &apiError{Code: "missing_target", Message: "to is required"}})
				continue
			}
			if !c.relayBudget.allow(time.Now()) {
				c.deliver(wire{Type: "error", RequestID: m.RequestID, Error: &apiError{Code: "rate_limited", Message: "signaling messages are being sent too quickly"}})
				continue
			}
			m.From = c.peer
			if !a.Hub.relay(room, m.To, m) {
				c.deliver(wire{Type: "error", RequestID: m.RequestID, Error: &apiError{Code: "peer_unavailable", Message: "target is not connected"}})
			}
		default:
			c.deliver(wire{Type: "error", Error: &apiError{Code: "invalid_type", Message: "unsupported message type"}})
		}
	}
}
func (a *API) websocketOriginAllowed(r *http.Request) bool {
	o := r.Header.Get("Origin")
	// A handshake with no Origin did not come from a page.
	//
	// RFC 6455 obliges a browser to send one on every WebSocket handshake, so
	// its absence means a native client — the desktop host's loopback proxy is
	// one, and it strips the header precisely because the origin it would carry
	// describes the proxy, not the application. Such a client still has to
	// present a session cookie to get this far, which is the same protection
	// the HTTP side relies on in sameOrigin, and the websocket library itself
	// reasons the same way: its own origin check passes an absent Origin.
	//
	// Refusing it here is what made joining a room's voice fail in the packaged
	// desktop app while the browser, which always sends an Origin, connected.
	if o == "" {
		return true
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
