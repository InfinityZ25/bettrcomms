package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	voiceQueueSize   = 10
	voiceMaxAge      = 200 * time.Millisecond
	voiceSafeInteger = int64(9_007_199_254_740_991)
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type voiceWire struct {
	Type      string `json:"type"`
	To        string `json:"to,omitempty"`
	From      string `json:"from,omitempty"`
	Epoch     string `json:"epoch,omitempty"`
	Sequence  int64  `json:"sequence"`
	Data      string `json:"data,omitempty"`
	RequestID string `json:"request_id,omitempty"`
}

type queuedVoice struct {
	message  voiceWire
	received time.Time
}

type voiceClient struct {
	user      string
	owner     *client
	conn      *websocket.Conn
	send      chan queuedVoice
	closeOnce sync.Once
}

func (v *voiceClient) close(reason string) {
	if v.conn == nil {
		return
	}
	v.closeOnce.Do(func() { go func() { _ = v.conn.Close(websocket.StatusPolicyViolation, reason) }() })
}

func (v *voiceClient) enqueue(message voiceWire) {
	packet := queuedVoice{message: message, received: time.Now()}
	select {
	case v.send <- packet:
		return
	default:
	}
	select {
	case <-v.send:
	default:
	}
	select {
	case v.send <- packet:
	default:
	}
}

func (h *Hub) addVoice(room, user string, v *voiceClient) bool {
	h.mu.Lock()
	active := false
	for c := range h.rooms[room] {
		if c == v.owner && c.user == user {
			active = true
			break
		}
	}
	if !active {
		h.mu.Unlock()
		return false
	}
	if h.voices[room] == nil {
		h.voices[room] = map[string]*voiceClient{}
	}
	old := h.voices[room][user]
	h.voices[room][user] = v
	h.mu.Unlock()
	if old != nil && old != v {
		old.close("voice relay replaced")
	}
	return true
}

func (h *Hub) removeVoice(room, user string, v *voiceClient) {
	h.mu.Lock()
	if h.voices[room][user] == v {
		delete(h.voices[room], user)
	}
	if len(h.voices[room]) == 0 {
		delete(h.voices, room)
	}
	h.mu.Unlock()
}

func (h *Hub) activeSignal(room, user string) *client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[room] {
		if c.user == user {
			return c
		}
	}
	return nil
}

func (h *Hub) relayVoice(room string, sender *voiceClient, to string, message voiceWire) bool {
	h.mu.RLock()
	target := h.voices[room][to]
	valid := h.voices[room][sender.user] == sender && target != nil
	if valid {
		_, senderActive := h.rooms[room][sender.owner]
		_, targetActive := h.rooms[room][target.owner]
		valid = senderActive && targetActive
	}
	h.mu.RUnlock()
	if valid {
		target.enqueue(message)
	}
	return valid
}

type voiceRate struct {
	tokens  float64
	updated time.Time
}

func (r *voiceRate) allow(now time.Time) bool {
	if r.updated.IsZero() {
		r.tokens = 100
		r.updated = now
	}
	r.tokens += now.Sub(r.updated).Seconds() * 500
	if r.tokens > 100 {
		r.tokens = 100
	}
	r.updated = now
	if r.tokens < 1 {
		return false
	}
	r.tokens--
	return true
}

func validVoice(m voiceWire) bool {
	if m.Type != "voice" || !uuidPattern.MatchString(m.To) || len(m.Epoch) < 1 || len(m.Epoch) > 64 || m.Sequence < 0 || m.Sequence > voiceSafeInteger || len(m.Data) < 24 || len(m.Data) > 4096 {
		return false
	}
	b, err := base64.StdEncoding.DecodeString(m.Data)
	return err == nil && len(b) >= 16 && len(b) <= 3072
}

func decodeVoiceMessage(data []byte) (voiceWire, error) {
	var message voiceWire
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &message) != nil || json.Unmarshal(data, &fields) != nil {
		return message, errors.New("invalid JSON")
	}
	if message.Type == "voice" {
		if _, present := fields["sequence"]; !present {
			return message, errors.New("sequence is required")
		}
	}
	return message, nil
}

func (a *API) voiceRelay(w http.ResponseWriter, r *http.Request, u User, room string) {
	if r.Method != http.MethodGet {
		a.fail(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if _, err := a.Store.RoomForMember(room, u.ID); err != nil {
		a.fail(w, http.StatusForbidden, "not_a_member", "room membership required")
		return
	}
	if !a.websocketOriginAllowed(r) {
		a.fail(w, http.StatusForbidden, "origin_not_allowed", "WebSocket origin is not allowed")
		return
	}
	owner := a.Hub.activeSignal(room, u.ID)
	if owner == nil {
		a.fail(w, http.StatusConflict, "signaling_required", "an active signaling connection is required")
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: a.AllowedOrigins})
	if err != nil {
		return
	}
	conn.SetReadLimit(8 << 10)
	v := &voiceClient{user: u.ID, owner: owner, conn: conn, send: make(chan queuedVoice, voiceQueueSize)}
	if !a.Hub.addVoice(room, u.ID, v) {
		_ = conn.Close(websocket.StatusPolicyViolation, "signaling connection is no longer active")
		return
	}
	defer func() { a.Hub.removeVoice(room, u.ID, v); conn.CloseNow() }()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case packet := <-v.send:
				if time.Since(packet.received) > voiceMaxAge {
					continue
				}
				wc, stop := context.WithTimeout(ctx, time.Second)
				err := wsjsonWrite(wc, conn, packet.message)
				stop()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	rate := voiceRate{}
	targets := map[string]struct{}{}
	for {
		messageType, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if messageType != websocket.MessageText {
			_ = conn.Close(websocket.StatusUnsupportedData, "voice relay accepts JSON text only")
			return
		}
		message, err := decodeVoiceMessage(data)
		if err != nil {
			_ = conn.Close(websocket.StatusPolicyViolation, "invalid voice message")
			return
		}
		if message.Type == "ping" {
			if len(message.RequestID) < 1 || len(message.RequestID) > 128 {
				_ = conn.Close(websocket.StatusPolicyViolation, "invalid ping")
				return
			}
			v.enqueue(voiceWire{Type: "pong", RequestID: message.RequestID})
			continue
		}
		if !validVoice(message) {
			_ = conn.Close(websocket.StatusPolicyViolation, "invalid voice packet")
			return
		}
		if !rate.allow(time.Now()) {
			_ = conn.Close(websocket.StatusPolicyViolation, "voice packet rate exceeded")
			return
		}
		if _, exists := targets[message.To]; !exists {
			if len(targets) >= 8 {
				_ = conn.Close(websocket.StatusPolicyViolation, "voice target limit exceeded")
				return
			}
			targets[message.To] = struct{}{}
		}
		message.From = u.ID
		a.Hub.relayVoice(room, v, message.To, message)
	}
}
