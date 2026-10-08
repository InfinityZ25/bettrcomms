package api

import (
	"context"
	"net/http"
	"strings"
)

// Called inside the existing community dispatcher and its ACL mutation lock.
func (a *API) routePermissionFeatures(w http.ResponseWriter, r *http.Request, path []string, user User, community Community) bool {
	if len(path) < 3 {
		return false
	}
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		return false
	}
	id := strings.ToLower(path[1])
	if path[2] == "roles" {
		if len(path) == 3 && r.Method == http.MethodGet {
			roles, err := store.CustomRoles(id, user.ID)
			a.result(w, map[string]any{"roles": roles}, err)
			return true
		}
		if len(path) == 3 && r.Method == http.MethodPost || len(path) == 4 && r.Method == http.MethodPatch {
			roleID := ""
			if len(path) == 4 {
				roleID = strings.ToLower(path[3])
				if !uuidPattern.MatchString(roleID) {
					a.fail(w, 400, "invalid_role", "choose a custom role")
					return true
				}
			}
			var in CustomRole
			if !a.decode(w, r, &in) {
				return true
			}
			role, err := store.SaveCustomRole(id, user.ID, roleID, in)
			if err == nil {
				a.communityChanged(community)
			}
			if err == ErrInvalidPermissions {
				a.fail(w, 400, "invalid_role", "use a unique role name up to 60 characters, a hex color and channel permissions")
				return true
			}
			status := 200
			if roleID == "" {
				status = 201
			}
			a.resultStatus(w, map[string]any{"role": role}, err, status)
			return true
		}
		if len(path) == 4 && r.Method == http.MethodDelete && uuidPattern.MatchString(path[3]) {
			err := store.DeleteCustomRole(id, user.ID, strings.ToLower(path[3]))
			if err == nil {
				a.communityChanged(community)
			}
			a.result(w, map[string]bool{"ok": true}, err)
			return true
		}
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return true
	}
	if len(path) == 5 && path[2] == "members" && path[4] == "custom-roles" {
		if r.Method != http.MethodPut {
			a.fail(w, 405, "method_not_allowed", "method not allowed")
			return true
		}
		if !uuidPattern.MatchString(path[3]) {
			a.fail(w, 400, "invalid_user", "choose a member")
			return true
		}
		var in struct {
			RoleIDs []string `json:"role_ids"`
		}
		if !a.decode(w, r, &in) {
			return true
		}
		for i, role := range in.RoleIDs {
			in.RoleIDs[i] = strings.ToLower(role)
		}
		err := store.SetMemberCustomRoles(id, user.ID, strings.ToLower(path[3]), in.RoleIDs)
		if err == nil {
			a.communityChanged(community)
		}
		if err == ErrInvalidPermissions {
			a.fail(w, 400, "invalid_roles", "choose existing roles from this room")
			return true
		}
		a.result(w, map[string]bool{"ok": true}, err)
		return true
	}
	if len(path) == 5 && path[2] == "channels" && path[4] == "permissions" {
		if !uuidPattern.MatchString(path[3]) {
			a.fail(w, 400, "invalid_channel", "choose a channel")
			return true
		}
		room := strings.ToLower(path[3])
		if r.Method == http.MethodGet {
			access, err := store.ChannelAccess(id, room, user.ID)
			a.result(w, map[string]any{"access": access}, err)
			return true
		}
		if r.Method == http.MethodPut {
			var in ChannelAccess
			if !a.decode(w, r, &in) {
				return true
			}
			for i := range in.Overrides {
				in.Overrides[i].SubjectKey = strings.ToLower(in.Overrides[i].SubjectKey)
			}
			err := store.SetChannelAccess(id, room, user.ID, in)
			if err == nil {
				a.communityChanged(community)
			}
			if err == ErrInvalidPermissions {
				a.fail(w, 400, "invalid_permissions", "choose valid channel permissions and roles from this room")
				return true
			}
			a.result(w, map[string]bool{"ok": true}, err)
			return true
		}
		a.fail(w, 405, "method_not_allowed", "method not allowed")
		return true
	}
	return false
}

// Socket admission and these mutations share accessMu. Re-evaluate all siblings
// before admitting another socket so removed roles cannot retain a subscription.
func (a *API) reconcileCommunityAccess(c Community) {
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		return
	}
	type admission struct {
		user, room  string
		read, voice bool
	}
	rows, err := store.DB.Query(context.Background(), `SELECT cm.user_id::text,r.id::text,can_access_room(r.id,cm.user_id),room_has_permission(r.id,cm.user_id,'join_voice')
 FROM community_members cm JOIN users account ON account.id=cm.user_id AND account.deleted_at IS NULL
 JOIN rooms r ON r.community_id=cm.community_id WHERE cm.community_id=$1`, c.ID)
	admissions := []admission{}
	if err == nil {
		for rows.Next() {
			var value admission
			if err = rows.Scan(&value.user, &value.room, &value.read, &value.voice); err != nil {
				break
			}
			admissions = append(admissions, value)
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
	}
	if err != nil {
		for _, room := range c.Channels {
			a.Realtime.unsubscribeRoom(room.ID)
			a.Hub.disconnectRoom(room.ID)
			a.revokeSFU(room.ID, "", "")
		}
		return
	}
	notified := map[string]bool{}
	for _, value := range admissions {
		if !notified[value.user] {
			a.Realtime.publishUser(value.user, wire{Type: "rooms.changed"})
			notified[value.user] = true
		}
		if value.read {
			a.Realtime.subscribeUser(value.room, value.user)
		} else {
			a.Realtime.unsubscribeUser(value.room, value.user)
		}
		if !value.read || !value.voice {
			a.Hub.disconnectRoomUser(value.room, value.user)
			a.revokeSFU(value.room, value.user, "")
		}
	}
}

func (a *API) communityChannelIDs(c Community) ([]Room, error) {
	store, ok := a.Store.(*PostgresStore)
	if !ok {
		return c.Channels, nil
	}
	rows, err := store.DB.Query(context.Background(), `SELECT id::text FROM rooms WHERE community_id=$1`, c.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	channels := []Room{}
	for rows.Next() {
		var room Room
		if err = rows.Scan(&room.ID); err != nil {
			return nil, err
		}
		channels = append(channels, room)
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}
	return channels, nil
}
