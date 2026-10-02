package api

import "github.com/coder/websocket"

func (h *RealtimeHub) disconnectSession(session string) {
	h.mu.RLock()
	targets := []*realtimeClient{}
	for _, clients := range h.users {
		for c := range clients {
			if c.session == session {
				targets = append(targets, c)
			}
		}
	}
	h.mu.RUnlock()
	for _, c := range targets {
		c.revoked.Store(true)
		h.remove(c)
		go c.conn.Close(websocket.StatusPolicyViolation, "session revoked")
	}
}
func (h *RealtimeHub) publishAll(message wire) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, clients := range h.users {
		for c := range clients {
			enqueueRealtime(c, message)
		}
	}
}
func (h *Hub) disconnectSession(session string) {
	type target struct {
		room string
		c    *client
	}
	h.mu.RLock()
	targets := []target{}
	for room, clients := range h.rooms {
		for c := range clients {
			if c.session == session {
				targets = append(targets, target{room, c})
			}
		}
	}
	h.mu.RUnlock()
	for _, item := range targets {
		item.c.revoked.Store(true)
		h.remove(item.room, item.c)
		go item.c.conn.Close(websocket.StatusPolicyViolation, "session revoked")
	}
}
