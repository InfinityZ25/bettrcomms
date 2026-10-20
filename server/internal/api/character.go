package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// Variant zero and a nil hue retain the account's original generated character.
type CharacterAppearance struct {
	Variant int  `json:"variant"`
	Hue     *int `json:"hue"`
}

type CharacterStore interface {
	SetCharacter(string, CharacterAppearance) (User, error)
	AuthorizeCharacterGesture(context.Context, string, string, string) (string, error)
}

func validCharacter(character CharacterAppearance) bool {
	return character.Variant >= 0 && character.Variant <= 5 && (character.Hue == nil || *character.Hue >= 0 && *character.Hue <= 359)
}

func (a *API) decodeCharacterInput(w http.ResponseWriter, r *http.Request, input any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		a.fail(w, 415, "content_type", "application/json required")
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(input); err != nil {
		a.fail(w, 400, "invalid_json", "invalid request body")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		a.fail(w, 400, "invalid_json", "provide one request object")
		return false
	}
	return true
}

func (a *API) character(w http.ResponseWriter, r *http.Request, user User) {
	if r.Method != http.MethodPatch {
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	store, ok := a.Store.(CharacterStore)
	if !ok {
		a.fail(w, 503, "unavailable", "character unavailable")
		return
	}
	var input struct {
		Variant *int            `json:"variant"`
		Hue     json.RawMessage `json:"hue"`
	}
	if !a.decodeCharacterInput(w, r, &input) {
		return
	}
	var hue *int
	if input.Variant == nil || len(input.Hue) == 0 || json.Unmarshal(input.Hue, &hue) != nil {
		a.fail(w, 400, "invalid_character", "provide a variant from 0 to 5 and a hue from 0 to 359 or null")
		return
	}
	appearance := CharacterAppearance{Variant: *input.Variant, Hue: hue}
	if !validCharacter(appearance) {
		a.fail(w, 400, "invalid_character", "provide a variant from 0 to 5 and a hue from 0 to 359 or null")
		return
	}
	if !a.limiter.allow("profile:"+user.ID, 30, time.Hour) {
		a.fail(w, 429, "rate_limited", "too many profile changes")
		return
	}
	updated, err := store.SetCharacter(user.ID, appearance)
	if err == nil {
		rooms, _ := a.Store.ListRooms(user.ID)
		a.Realtime.publishProfile(updated, rooms)
		if profile, ok := a.Store.(ProfileStore); ok {
			updated.PresenceStatus, _ = profile.Presence(user.ID)
		}
	}
	a.result(w, map[string]any{"user": updated}, err)
}

func (a *API) characterGesture(w http.ResponseWriter, r *http.Request, user User, room string) {
	if r.Method != http.MethodPost {
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	store, ok := a.Store.(CharacterStore)
	if !ok {
		a.fail(w, 503, "unavailable", "character gestures unavailable")
		return
	}
	var input struct {
		Gesture      string `json:"gesture"`
		ThreadRootID string `json:"thread_root_id,omitempty"`
	}
	if !a.decodeCharacterInput(w, r, &input) {
		return
	}
	if input.Gesture != "wave" && input.Gesture != "nod" && input.Gesture != "celebrate" || input.ThreadRootID != "" && !uuidPattern.MatchString(input.ThreadRootID) {
		a.fail(w, 400, "invalid_gesture", "choose wave, nod or celebrate and a valid thread")
		return
	}
	if !a.limiter.allow("character-gesture-burst:"+user.ID, 1, 3*time.Second) || !a.limiter.allow("character-gesture-minute:"+user.ID, 30, time.Minute) {
		w.Header().Set("Retry-After", "3")
		a.fail(w, 429, "rate_limited", "wait before another gesture")
		return
	}
	input.ThreadRootID = strings.ToLower(input.ThreadRootID)
	id, err := store.AuthorizeCharacterGesture(r.Context(), room, user.ID, input.ThreadRootID)
	if err != nil {
		a.result(w, nil, err)
		return
	}
	payload := struct {
		ID           string              `json:"id"`
		RoomID       string              `json:"room_id"`
		UserID       string              `json:"user_id"`
		Name         string              `json:"name"`
		Gesture      string              `json:"gesture"`
		ThreadRootID string              `json:"thread_root_id,omitempty"`
		Character    CharacterAppearance `json:"character"`
	}{id, room, user.ID, user.Name, input.Gesture, input.ThreadRootID, user.Character}
	data, _ := json.Marshal(payload)
	// Live room fanout deliberately bypasses the durable message/event history.
	a.Realtime.publishRoom(room, wire{Type: "character.gesture", From: user.ID, Payload: data})
	w.WriteHeader(http.StatusNoContent)
}

func (s *PostgresStore) SetCharacter(user string, appearance CharacterAppearance) (User, error) {
	if !validCharacter(appearance) {
		return User{}, ErrForbidden
	}
	return scanUser(s.DB.QueryRow(context.Background(), `UPDATE users SET character_variant=$2,character_hue=$3,profile_version=profile_version+1,updated_at=clock_timestamp() WHERE id=$1 AND deleted_at IS NULL RETURNING `+userCols, user, appearance.Variant, appearance.Hue))
}

func (s *PostgresStore) AuthorizeCharacterGesture(ctx context.Context, room, user, thread string) (string, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	// A gesture is a posting action: restrictions, private reads, blocks and
	// slowmode apply even though no durable message is created.
	if err = checkRoomPosting(ctx, tx, room, user, true); err != nil {
		return "", err
	}
	if thread != "" {
		var found string
		err = tx.QueryRow(ctx, `SELECT id::text FROM messages WHERE id=$1 AND room_id=$2 AND thread_root_id IS NULL AND deleted_at IS NULL FOR SHARE`, thread, room).Scan(&found)
		if err != nil {
			return "", norm(err)
		}
	}
	var id string
	if err = tx.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}
