package api

import (
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

func validCommunityText(value string, minimum, maximum int) bool {
	length := utf8.RuneCountInString(value)
	return length >= minimum && length <= maximum
}

func (a *API) communities(w http.ResponseWriter, r *http.Request, user User, path []string) {
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "communities unavailable")
		return
	}
	if r.Method != http.MethodGet && !a.limiter.allow("community-admin:"+user.ID, 60, time.Minute) {
		a.fail(w, 429, "rate_limited", "too many community changes")
		return
	}
	if len(path) == 1 {
		if r.Method == http.MethodGet {
			items, err := store.ListCommunities(user.ID)
			a.result(w, map[string]any{"communities": items}, err)
			return
		}
		if r.Method == http.MethodPost {
			var in struct {
				Name        string `json:"name"`
				Description string `json:"description"`
			}
			if !a.decode(w, r, &in) {
				return
			}
			in.Name, in.Description = strings.TrimSpace(in.Name), strings.TrimSpace(in.Description)
			if !validCommunityText(in.Name, 1, 100) || !validCommunityText(in.Description, 0, 500) {
				a.fail(w, 400, "invalid_community", "name must be 1–100 characters and description up to 500")
				return
			}
			c, err := store.CreateCommunity(user.ID, in.Name, in.Description, "general")
			if err == nil {
				a.communityMembershipChanged(c, user.ID, true)
			}
			a.resultStatus(w, map[string]any{"community": c}, err, 201)
			return
		}
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	id := strings.ToLower(path[1])
	if !uuidPattern.MatchString(id) {
		a.fail(w, 404, "not_found", "community not found")
		return
	}
	c, err := store.CommunityForMember(id, user.ID)
	if err != nil {
		a.result(w, nil, err)
		return
	}
	if len(path) == 2 {
		switch r.Method {
		case http.MethodGet:
			a.json(w, 200, map[string]any{"community": c})
		case http.MethodPatch:
			var in struct {
				Name        *string `json:"name"`
				Description *string `json:"description"`
			}
			if !a.decode(w, r, &in) {
				return
			}
			if in.Name != nil {
				*in.Name = strings.TrimSpace(*in.Name)
			}
			if in.Description != nil {
				*in.Description = strings.TrimSpace(*in.Description)
			}
			if in.Name != nil && !validCommunityText(*in.Name, 1, 100) || in.Description != nil && !validCommunityText(*in.Description, 0, 500) || in.Name == nil && in.Description == nil {
				a.fail(w, 400, "invalid_community", "provide a name of 1–100 characters or description up to 500")
				return
			}
			updated, err := store.UpdateCommunity(id, user.ID, in.Name, in.Description)
			if err == nil {
				a.communityChanged(updated)
			}
			a.result(w, map[string]any{"community": updated}, err)
		case http.MethodDelete:
			err := store.DeleteCommunity(id, user.ID)
			if err == nil {
				for _, room := range c.Channels {
					a.deletedChannel(room.ID)
				}
			}
			a.result(w, map[string]bool{"ok": true}, err)
		default:
			a.fail(w, 405, "method_not_allowed", "method not allowed")
		}
		return
	}
	if path[2] == "members" {
		if len(path) == 3 && r.Method == http.MethodGet {
			members, err := store.CommunityMembers(id, user.ID)
			a.result(w, map[string]any{"members": members}, err)
			return
		}
		if len(path) == 3 && r.Method == http.MethodPost {
			var in struct {
				UserID string `json:"user_id"`
			}
			if !a.decode(w, r, &in) {
				return
			}
			if !uuidPattern.MatchString(in.UserID) {
				a.fail(w, 400, "invalid_user", "choose a friend")
				return
			}
			target := strings.ToLower(in.UserID)
			err := store.AddCommunityMember(id, user.ID, target)
			if err == nil {
				a.communityMembershipChanged(c, target, true)
			}
			a.resultStatus(w, map[string]bool{"ok": true}, err, 201)
			return
		}
		if len(path) >= 4 && uuidPattern.MatchString(path[3]) {
			target := strings.ToLower(path[3])
			if len(path) == 4 && r.Method == http.MethodDelete {
				err := store.RemoveCommunityMember(id, user.ID, target)
				if err == nil {
					a.communityMembershipChanged(c, target, false)
				}
				a.result(w, map[string]bool{"ok": true}, err)
				return
			}
			if len(path) == 5 && path[4] == "role" && r.Method == http.MethodPut {
				var in struct {
					Role string `json:"role"`
				}
				if !a.decode(w, r, &in) {
					return
				}
				if in.Role != "admin" && in.Role != "moderator" && in.Role != "member" {
					a.fail(w, 400, "invalid_role", "role must be admin, moderator or member")
					return
				}
				err := store.SetCommunityRole(id, user.ID, target, in.Role)
				if err == nil {
					a.communityChanged(c)
				}
				a.result(w, map[string]bool{"ok": true}, err)
				return
			}
		}
	}
	if len(path) == 3 && path[2] == "ownership" && r.Method == http.MethodPost {
		var in struct {
			UserID string `json:"user_id"`
		}
		if !a.decode(w, r, &in) {
			return
		}
		if !uuidPattern.MatchString(in.UserID) {
			a.fail(w, 400, "invalid_user", "choose a member")
			return
		}
		err := store.TransferCommunityOwner(r.Context(), id, user.ID, strings.ToLower(in.UserID))
		if err == nil {
			a.communityChanged(c)
		}
		a.result(w, map[string]bool{"ok": true}, err)
		return
	}
	if path[2] == "channels" {
		if len(path) == 3 && r.Method == http.MethodPost {
			var in struct {
				Name        string `json:"name"`
				Topic       string `json:"topic"`
				ChannelType string `json:"channel_type"`
			}
			if !a.decode(w, r, &in) {
				return
			}
			in.Name, in.Topic = strings.TrimSpace(in.Name), strings.TrimSpace(in.Topic)
			if in.ChannelType == "" {
				in.ChannelType = "hybrid"
			}
			if !validCommunityText(in.Name, 1, 100) || !validCommunityText(in.Topic, 0, 500) || in.ChannelType != "hybrid" && in.ChannelType != "announcement" {
				a.fail(w, 400, "invalid_channel", "provide a channel name, topic up to 500 characters and hybrid or announcement type")
				return
			}
			room, err := store.CreateChannel(id, user.ID, in.Name, in.Topic, in.ChannelType)
			if err == nil {
				members, memberErr := store.CommunityMembers(id, user.ID)
				if memberErr == nil {
					for _, member := range members {
						a.Realtime.subscribeUser(room.ID, member.User.ID)
					}
				}
				c.Channels = append(c.Channels, room)
				a.communityChanged(c)
			}
			a.resultStatus(w, map[string]any{"room": room}, err, 201)
			return
		}
		if len(path) == 4 && path[3] == "reorder" && r.Method == http.MethodPost {
			var in struct {
				ChannelIDs []string `json:"channel_ids"`
			}
			if !a.decode(w, r, &in) {
				return
			}
			if len(in.ChannelIDs) == 0 || len(in.ChannelIDs) > 1000 {
				a.fail(w, 400, "invalid_channels", "provide every channel exactly once")
				return
			}
			for i, channel := range in.ChannelIDs {
				if !uuidPattern.MatchString(channel) {
					a.fail(w, 400, "invalid_channel", "channel IDs must be UUIDs")
					return
				}
				in.ChannelIDs[i] = strings.ToLower(channel)
			}
			updated, err := store.ReorderChannels(id, user.ID, in.ChannelIDs)
			if err == nil {
				a.communityChanged(updated)
			}
			a.result(w, map[string]any{"community": updated}, err)
			return
		}
		if len(path) == 4 && uuidPattern.MatchString(path[3]) {
			room := strings.ToLower(path[3])
			if r.Method == http.MethodPatch {
				var in ChannelUpdate
				if !a.decode(w, r, &in) {
					return
				}
				if in.Name != nil {
					*in.Name = strings.TrimSpace(*in.Name)
				}
				if in.Topic != nil {
					*in.Topic = strings.TrimSpace(*in.Topic)
				}
				if in.Name != nil && !validCommunityText(*in.Name, 1, 100) || in.Topic != nil && !validCommunityText(*in.Topic, 0, 500) || in.ChannelType != nil && *in.ChannelType != "hybrid" && *in.ChannelType != "announcement" || in.Position != nil && (*in.Position < 0 || *in.Position > 100000) {
					a.fail(w, 400, "invalid_channel", "channel settings are invalid")
					return
				}
				updated, err := store.UpdateChannel(id, room, user.ID, in)
				if err == nil {
					if updated.ChannelType == "announcement" {
						a.Hub.disconnectRoom(room)
						a.revokeSFU(room, "", "")
					}
					a.communityChanged(c)
				}
				a.result(w, map[string]any{"room": updated}, err)
				return
			}
			if r.Method == http.MethodDelete {
				err := store.DeleteChannel(id, room, user.ID)
				if err == nil {
					a.deletedChannel(room)
					a.communityChanged(c)
				}
				a.result(w, map[string]bool{"ok": true}, err)
				return
			}
		}
	}
	a.fail(w, 404, "not_found", "community action not found")
}

func (a *API) communityChanged(c Community) {
	for _, room := range c.Channels {
		a.moderationChanged(room.ID)
	}
}

func (a *API) communityMembershipChanged(c Community, user string, added bool) {
	a.Realtime.publishUser(user, wire{Type: "rooms.changed"})
	for _, room := range c.Channels {
		if added {
			a.Realtime.subscribeUser(room.ID, user)
		} else {
			a.Realtime.unsubscribeUser(room.ID, user)
			a.Hub.disconnectRoomUser(room.ID, user)
			a.revokeSFU(room.ID, user, "")
		}
		a.moderationChanged(room.ID)
	}
}

func (a *API) deletedChannel(room string) {
	a.Realtime.publishRoom(room, wire{Type: "rooms.changed"})
	a.Realtime.unsubscribeRoom(room)
	a.Hub.disconnectRoom(room)
	a.revokeSFU(room, "", "")
}

func (a *API) requireVoice(w http.ResponseWriter, room, user string) bool {
	if store, ok := a.Store.(*PostgresStore); ok {
		if err := store.RoomPermission(room, user, "join_voice"); err != nil {
			a.fail(w, 403, "voice_unavailable", "voice is available in hybrid channels")
			return false
		}
	}
	return true
}

func (a *API) forwardSignal(room string, sender *client, message wire) bool {
	a.accessMu.RLock()
	defer a.accessMu.RUnlock()
	return !sender.revoked.Load() && a.Hub.relay(room, message.To, message)
}
