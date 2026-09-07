package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// realtimeClient is the authenticated, app-wide event stream for one tab or
// desktop window. Room subscriptions are derived on the server from the
// persisted membership list; clients cannot subscribe themselves to rooms.
type realtimeClient struct {
	user     string
	conn     *websocket.Conn
	send     chan wire
	rooms    map[string]struct{}
	contacts map[string]struct{}
}

type RealtimeHub struct {
	mu       sync.RWMutex
	users    map[string]map[*realtimeClient]struct{}
	rooms    map[string]map[*realtimeClient]struct{}
	watchers map[string]map[*realtimeClient]struct{}
}

func NewRealtimeHub() *RealtimeHub {
	return &RealtimeHub{
		users:    map[string]map[*realtimeClient]struct{}{},
		rooms:    map[string]map[*realtimeClient]struct{}{},
		watchers: map[string]map[*realtimeClient]struct{}{},
	}
}

func (h *RealtimeHub) add(c *realtimeClient, rooms []Room, friends []User) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	becameOnline := len(h.users[c.user]) == 0
	if h.users[c.user] == nil {
		h.users[c.user] = map[*realtimeClient]struct{}{}
	}
	h.users[c.user][c] = struct{}{}
	for _, room := range rooms {
		h.subscribeLocked(c, room.ID)
	}
	for _, friend := range friends {
		h.subscribeContactLocked(c, friend.ID)
	}
	return becameOnline
}

func (h *RealtimeHub) subscribeLocked(c *realtimeClient, room string) {
	if c.rooms == nil {
		c.rooms = map[string]struct{}{}
	}
	if _, exists := c.rooms[room]; exists {
		return
	}
	if h.rooms[room] == nil {
		h.rooms[room] = map[*realtimeClient]struct{}{}
	}
	c.rooms[room] = struct{}{}
	h.rooms[room][c] = struct{}{}
}

func (h *RealtimeHub) subscribeContactLocked(c *realtimeClient, contact string) {
	if c.contacts == nil {
		c.contacts = map[string]struct{}{}
	}
	if _, exists := c.contacts[contact]; exists {
		return
	}
	if h.watchers[contact] == nil {
		h.watchers[contact] = map[*realtimeClient]struct{}{}
	}
	c.contacts[contact] = struct{}{}
	h.watchers[contact][c] = struct{}{}
}

func (h *RealtimeHub) remove(c *realtimeClient) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.users[c.user], c)
	becameOffline := len(h.users[c.user]) == 0
	if len(h.users[c.user]) == 0 {
		delete(h.users, c.user)
	}
	for room := range c.rooms {
		delete(h.rooms[room], c)
		if len(h.rooms[room]) == 0 {
			delete(h.rooms, room)
		}
	}
	for contact := range c.contacts {
		delete(h.watchers[contact], c)
		if len(h.watchers[contact]) == 0 {
			delete(h.watchers, contact)
		}
	}
	return becameOffline
}

func (h *RealtimeHub) subscribeUser(room, user string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.users[user] {
		h.subscribeLocked(c, room)
	}
}

func (h *RealtimeHub) unsubscribeUser(room, user string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.users[user] {
		delete(c.rooms, room)
		delete(h.rooms[room], c)
	}
	if len(h.rooms[room]) == 0 {
		delete(h.rooms, room)
	}
}

func (h *RealtimeHub) unsubscribeRoom(room string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.rooms[room] {
		delete(c.rooms, room)
	}
	delete(h.rooms, room)
}

func (h *RealtimeHub) subscribeContacts(left, right string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.users[left] {
		h.subscribeContactLocked(c, right)
	}
	for c := range h.users[right] {
		h.subscribeContactLocked(c, left)
	}
}

func (h *RealtimeHub) unsubscribeContacts(left, right string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.users[left] {
		delete(c.contacts, right)
		delete(h.watchers[right], c)
	}
	for c := range h.users[right] {
		delete(c.contacts, left)
		delete(h.watchers[left], c)
	}
	if len(h.watchers[left]) == 0 {
		delete(h.watchers, left)
	}
	if len(h.watchers[right]) == 0 {
		delete(h.watchers, right)
	}
}

func (h *RealtimeHub) onlineContacts(c *realtimeClient) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	result := make([]string, 0, len(c.contacts))
	for contact := range c.contacts {
		if len(h.users[contact]) > 0 {
			result = append(result, contact)
		}
	}
	return result
}

func (h *RealtimeHub) publishOnline(user string, online bool) {
	payload, _ := json.Marshal(map[string]any{"user_id": user, "online": online})
	h.mu.RLock()
	defer h.mu.RUnlock()
	// A reconnect can overlap the old socket's cleanup. Suppress a stale
	// offline/online transition when the aggregate device state has changed.
	if (len(h.users[user]) > 0) != online {
		return
	}
	for c := range h.watchers[user] {
		enqueueRealtime(c, wire{Type: "user.presence", Payload: payload})
	}
}

func (h *RealtimeHub) publishContactState(user, contact string) {
	h.mu.RLock()
	online := len(h.users[contact]) > 0
	h.mu.RUnlock()
	payload, _ := json.Marshal(map[string]any{"user_id": contact, "online": online})
	h.publishUser(user, wire{Type: "user.presence", Payload: payload})
}

func (h *RealtimeHub) publishRoom(room string, message wire) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[room] {
		enqueueRealtime(c, message)
	}
}

func (h *RealtimeHub) publishUser(user string, message wire) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.users[user] {
		enqueueRealtime(c, message)
	}
}

func enqueueRealtime(c *realtimeClient, message wire) {
	select {
	case c.send <- message:
	default:
		// A stalled client will reconnect and receive a fresh snapshot. Closing
		// avoids silently showing a partially updated state indefinitely.
		go c.conn.Close(websocket.StatusPolicyViolation, "event stream is too slow")
	}
}

func (h *RealtimeHub) disconnectUser(user string) {
	h.mu.RLock()
	targets := make([]*realtimeClient, 0, len(h.users[user]))
	for c := range h.users[user] {
		targets = append(targets, c)
	}
	h.mu.RUnlock()
	for _, c := range targets {
		go c.conn.Close(websocket.StatusPolicyViolation, "session revoked")
	}
}

func (a *API) publishCallPresence(room string) {
	payload, _ := json.Marshal(RoomCallPresence{
		RoomID:       room,
		Participants: a.Hub.callPresence(room),
	})
	a.Realtime.publishRoom(room, wire{Type: "call.presence", Payload: payload})
}

func (a *API) realtimeWebsocket(w http.ResponseWriter, r *http.Request, user User) {
	if !a.websocketOriginAllowed(r) {
		a.fail(w, http.StatusForbidden, "origin_not_allowed", "WebSocket origin is not allowed")
		return
	}
	rooms, err := a.Store.ListRooms(user.ID)
	if err != nil {
		a.result(w, nil, err)
		return
	}
	friends, _, err := a.Store.ListFriends(user.ID)
	if err != nil {
		a.result(w, nil, err)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: a.AllowedOrigins})
	if err != nil {
		return
	}
	conn.SetReadLimit(8 << 10)
	client := &realtimeClient{user: user.ID, conn: conn, send: make(chan wire, 128), rooms: map[string]struct{}{}, contacts: map[string]struct{}{}}
	becameOnline := a.Realtime.add(client, rooms, friends)
	defer func() {
		if a.Realtime.remove(client) {
			a.Realtime.publishOnline(user.ID, false)
		}
		conn.CloseNow()
	}()

	presence := make([]RoomCallPresence, 0, len(rooms))
	for _, room := range rooms {
		presence = append(presence, RoomCallPresence{RoomID: room.ID, Participants: a.Hub.callPresence(room.ID)})
	}
	payload, _ := json.Marshal(map[string]any{"presence": presence, "online_user_ids": a.Realtime.onlineContacts(client)})
	if err = wsjsonWrite(r.Context(), conn, wire{Type: "app.ready", Payload: payload}); err != nil {
		return
	}
	if becameOnline {
		a.Realtime.publishOnline(user.ID, true)
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case message := <-client.send:
				writeContext, writeCancel := context.WithTimeout(ctx, 5*time.Second)
				err := wsjsonWrite(writeContext, conn, message)
				writeCancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()

	for {
		var message wire
		readContext, readCancel := context.WithTimeout(ctx, 45*time.Second)
		err := wsjsonRead(readContext, conn, &message)
		readCancel()
		if err != nil {
			return
		}
		if message.Type != "ping" || message.RequestID == "" || len(message.RequestID) > 128 {
			enqueueRealtime(client, wire{Type: "error", Error: &apiError{Code: "invalid_event", Message: "only ping events are accepted"}})
			continue
		}
		enqueueRealtime(client, wire{Type: "pong", RequestID: message.RequestID})
	}
}
