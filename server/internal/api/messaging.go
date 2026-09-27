package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func pageLimit(r *http.Request) int {
	n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if n < 1 || n > 100 {
		return 50
	}
	return n
}

func (a *API) messagingGlobal(w http.ResponseWriter, r *http.Request, u User, path string) {
	store, ok := a.Store.(MessagingStore)
	if !ok {
		a.fail(w, 503, "unavailable", "Messaging is unavailable")
		return
	}
	if r.Method != "GET" {
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	if path == "messages/unread" {
		v, err := store.UnreadRooms(u.ID)
		a.result(w, map[string]any{"rooms": v}, err)
		return
	}
	if !a.limiter.allow("message-search:"+u.ID, 90, time.Minute) {
		a.fail(w, 429, "rate_limited", "too many searches")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	room, author := r.URL.Query().Get("room_id"), r.URL.Query().Get("author_id")
	if utf8.RuneCountInString(q) < 2 || utf8.RuneCountInString(q) > 200 || (room != "" && !uuidPattern.MatchString(room)) || (author != "" && !uuidPattern.MatchString(author)) {
		a.fail(w, 400, "invalid_search", "Use 2–200 characters and valid filters")
		return
	}
	page, err := store.SearchMessages(u.ID, room, author, q, r.URL.Query().Get("before_id"), pageLimit(r))
	a.result(w, page, err)
}

func (a *API) messagingRoom(w http.ResponseWriter, r *http.Request, u User, p []string, store MessagingStore) {
	room := p[1]
	if p[2] == "read" && len(p) == 3 && r.Method == "PUT" {
		var in struct {
			MessageID string `json:"message_id"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if !uuidPattern.MatchString(in.MessageID) {
			a.fail(w, 400, "invalid_message", "Choose a message in this conversation")
			return
		}
		err := store.ReadRoom(room, u.ID, in.MessageID)
		if err == nil {
			data, _ := json.Marshal(map[string]string{"room_id": room})
			a.Realtime.publishUser(u.ID, wire{Type: "chat.read", Payload: data})
		}
		a.result(w, map[string]bool{"ok": true}, err)
		return
	}
	if p[2] != "messages" {
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	if len(p) == 3 && r.Method == "GET" {
		if before := r.URL.Query().Get("before"); before != "" {
			// Preserve the timestamp-based history endpoint for older clients.
			a.fail(w, 400, "invalid_cursor", "Use before_id for message pagination")
			return
		}
		page, err := store.MessagePage(room, u.ID, r.URL.Query().Get("before_id"), pageLimit(r))
		a.result(w, page, err)
		return
	}
	if len(p) >= 4 && !uuidPattern.MatchString(p[3]) {
		a.fail(w, 404, "not_found", "message not found")
		return
	}
	if len(p) == 4 && r.Method == "GET" {
		m, err := store.MessageByID(room, p[3])
		a.result(w, map[string]any{"message": m}, err)
		return
	}
	var message Message
	var err error
	event := "chat.updated"
	status := http.StatusOK
	switch {
	case len(p) == 3 && r.Method == "POST", len(p) == 4 && r.Method == "PATCH":
		var in struct {
			Body    string `json:"body"`
			ReplyID string `json:"reply_to_id"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		in.Body = strings.TrimSpace(in.Body)
		if n := utf8.RuneCountInString(in.Body); n < 1 || n > 4000 {
			a.fail(w, 400, "invalid_body", "body must be 1–4000 characters")
			return
		}
		id := ""
		if len(p) == 4 {
			id = p[3]
		} else {
			event = "chat.message"
			status = http.StatusCreated
		}
		message, err = store.WriteMessage(room, u.ID, id, in.Body, in.ReplyID)
	case len(p) == 4 && r.Method == "DELETE":
		message, err = store.DeleteMessage(room, u.ID, p[3])
	case len(p) == 5 && p[4] == "reactions" && (r.Method == "PUT" || r.Method == "DELETE"):
		var in struct {
			Emoji string `json:"emoji"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if !reactionChoices[in.Emoji] {
			a.fail(w, 400, "invalid_reaction", "Choose an available reaction")
			return
		}
		message, err = store.ReactMessage(room, u.ID, p[3], in.Emoji, r.Method == "DELETE")
	default:
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	if err == nil {
		data, _ := json.Marshal(message)
		a.Hub.broadcast(room, nil, wire{Type: event, From: u.ID, Payload: data})
		a.Realtime.publishRoom(room, wire{Type: event, From: u.ID, Payload: data})
	}
	a.resultStatus(w, map[string]any{"message": message}, err, status)
}
