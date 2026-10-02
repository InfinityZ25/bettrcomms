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
	desired  map[string]string
}

func NewRealtimeHub() *RealtimeHub {
	return &RealtimeHub{
		users:    map[string]map[*realtimeClient]struct{}{},
		rooms:    map[string]map[*realtimeClient]struct{}{},
		watchers: map[string]map[*realtimeClient]struct{}{},
		desired:  map[string]string{},
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
			if len(h.users[contact]) == 0 {
				delete(h.desired, contact)
			}
		}
	}
	if len(h.users[c.user]) == 0 && len(h.watchers[c.user]) == 0 {
		delete(h.desired, c.user)
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
		if len(h.users[contact]) > 0 && h.desired[contact] != "invisible" {
			result = append(result, contact)
		}
	}
	return result
}

func (h *RealtimeHub) publishOnline(user string, online bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	// A reconnect can overlap the old socket's cleanup. Suppress a stale
	// offline/online transition when the aggregate device state has changed.
	if (len(h.users[user]) > 0) != online {
		return
	}
	status := h.effectivePresenceLocked(user)
	payload, _ := json.Marshal(map[string]any{"user_id": user, "online": status != "offline", "status": status})
	for c := range h.watchers[user] {
		enqueueRealtime(c, wire{Type: "user.presence", Payload: payload})
	}
}

func (h *RealtimeHub) publishContactState(user, contact string) {
	h.mu.RLock()
	status := h.effectivePresenceLocked(contact)
	h.mu.RUnlock()
	payload, _ := json.Marshal(map[string]any{"user_id": contact, "online": status != "offline", "status": status})
	h.publishUser(user, wire{Type: "user.presence", Payload: payload})
}

func (h *RealtimeHub) effectivePresenceLocked(user string) string {
	if len(h.users[user]) == 0 || h.desired[user] == "invisible" {
		return "offline"
	}
	if status := h.desired[user]; status != "" {
		return status
	}
	return "online"
}
func (h *RealtimeHub) desiredPresence(user string) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if s := h.desired[user]; s != "" {
		return s
	}
	return "online"
}
func (h *RealtimeHub) setPresence(user, status string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.desired[user] = status
	effective := h.effectivePresenceLocked(user)
	public, _ := json.Marshal(map[string]any{"user_id": user, "online": effective != "offline", "status": effective})
	own, _ := json.Marshal(map[string]any{"user_id": user, "online": effective != "offline", "status": effective, "desired_status": status})
	for c := range h.watchers[user] {
		enqueueRealtime(c, wire{Type: "user.presence", Payload: public})
	}
	for c := range h.users[user] {
		enqueueRealtime(c, wire{Type: "user.presence", Payload: own})
	}
}
func (h *RealtimeHub) contactSnapshot(c *realtimeClient) []map[string]any {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]map[string]any, 0, len(c.contacts))
	for id := range c.contacts {
		status := h.effectivePresenceLocked(id)
		out = append(out, map[string]any{"user_id": id, "online": status != "offline", "status": status})
	}
	return out
}
func (h *RealtimeHub) publishProfile(user User, rooms []Room) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	public, _ := json.Marshal(map[string]any{"user": user})
	ownUser := user
	ownUser.PresenceStatus = h.desired[user.ID]
	own, _ := json.Marshal(map[string]any{"user": ownUser})
	recipients := map[*realtimeClient]struct{}{}
	for c := range h.watchers[user.ID] {
		recipients[c] = struct{}{}
	}
	for _, room := range rooms {
		for peer := range h.rooms[room.ID] {
			recipients[peer] = struct{}{}
		}
	}
	for c := range recipients {
		if c.user != user.ID {
			enqueueRealtime(c, wire{Type: "user.profile", Payload: public})
		}
	}
	for c := range h.users[user.ID] {
		enqueueRealtime(c, wire{Type: "user.profile", Payload: own})
	}
}

func (h *RealtimeHub) publishRoom(room string, message wire) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[room] {
		enqueueRealtime(c, message)
	}
}

func (h *RealtimeHub) canPublishRoom(client *realtimeClient, room string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, allowed := client.rooms[room]
	return allowed
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
	a.membershipMu.RLock()
	registering := true
	defer func() {
		if registering {
			a.membershipMu.RUnlock()
		}
	}()
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
	a.presenceMu.Lock()
	if store, ok := a.Store.(ProfileStore); ok {
		ids := []string{user.ID}
		for _, friend := range friends {
			ids = append(ids, friend.ID)
		}
		values, loadErr := store.ContactPresence(ids)
		if loadErr != nil {
			a.presenceMu.Unlock()
			conn.CloseNow()
			return
		}
		a.Realtime.mu.Lock()
		for id, status := range values {
			a.Realtime.desired[id] = status
		}
		a.Realtime.mu.Unlock()
	}
	becameOnline := a.Realtime.add(client, rooms, friends)
	a.presenceMu.Unlock()
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
	payload, _ := json.Marshal(map[string]any{"presence": presence, "online_user_ids": a.Realtime.onlineContacts(client), "contact_presence": a.Realtime.contactSnapshot(client), "own_presence": map[string]string{"status": a.Realtime.desiredPresence(user.ID)}})
	readyContext, readyCancel := context.WithTimeout(r.Context(), 5*time.Second)
	err = wsjsonWrite(readyContext, conn, wire{Type: "app.ready", Payload: payload})
	readyCancel()
	if err != nil {
		return
	}
	if becameOnline {
		a.Realtime.publishOnline(user.ID, true)
	}
	a.membershipMu.RUnlock()
	registering = false

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
		if message.Type == "chat.typing" {
			var value struct {
				RoomID string `json:"room_id"`
				Typing bool   `json:"typing"`
			}
			if json.Unmarshal(message.Payload, &value) != nil || !uuidPattern.MatchString(value.RoomID) || !a.Realtime.canPublishRoom(client, value.RoomID) {
				enqueueRealtime(client, wire{Type: "error", Error: &apiError{Code: "forbidden", Message: "room membership required"}})
				continue
			}
			if !a.limiter.allow("chat-typing:"+user.ID+":"+value.RoomID, 60, time.Minute) {
				continue
			}
			payload, _ := json.Marshal(map[string]any{"room_id": value.RoomID, "user_id": user.ID, "typing": value.Typing})
			a.Realtime.publishRoom(value.RoomID, wire{Type: "chat.typing", From: user.ID, Payload: payload})
			continue
		}
		if message.Type != "ping" || message.RequestID == "" || len(message.RequestID) > 128 {
			enqueueRealtime(client, wire{Type: "error", Error: &apiError{Code: "invalid_event", Message: "only ping events are accepted"}})
			continue
		}
		enqueueRealtime(client, wire{Type: "pong", RequestID: message.RequestID})
	}
}
