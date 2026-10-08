package api

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestCustomPermissionInputCannotGrantAdministration(t *testing.T) {
	for _, permission := range []string{"manage_roles", "manage_channels", "manage_community", "moderate", "owner", ""} {
		if validCustomRole(CustomRole{Name: "Squad", Color: "#64748b", Permissions: map[string]bool{permission: true}}) {
			t.Errorf("accepted privilege %q", permission)
		}
		if validChannelAccess(ChannelAccess{Overrides: []ChannelOverride{{SubjectKey: "member", Permissions: map[string]string{permission: "allow"}}}}) {
			t.Errorf("accepted override privilege %q", permission)
		}
	}
	for _, name := range []string{"Owner", "ADMIN", "moderator", "member", " ", ""} {
		if validCustomRole(CustomRole{Name: name, Color: "#64748b"}) {
			t.Errorf("accepted reserved role %q", name)
		}
	}
	if validChannelAccess(ChannelAccess{Overrides: []ChannelOverride{{SubjectKey: "everyone", Permissions: map[string]string{"read": "allow"}}, {SubjectKey: "everyone", Permissions: map[string]string{"read": "deny"}}}}) {
		t.Fatal("accepted duplicated subject")
	}
	if validChannelAccess(ChannelAccess{Overrides: []ChannelOverride{{SubjectKey: "owner", Permissions: map[string]string{"read": "deny"}}}}) {
		t.Fatal("accepted owner override")
	}
}

func TestQueuedPrivateRoomEventsAreDroppedAfterReadRevocation(t *testing.T) {
	h := NewRealtimeHub()
	member := &realtimeClient{user: "member", send: make(chan wire, 8)}
	h.add(member, []Room{{ID: "private"}, {ID: "public"}}, nil)
	h.publishRoom("private", wire{Type: "chat.message", Payload: json.RawMessage(`{"room_id":"private","body":"private queued message"}`)})
	h.publishRoom("public", wire{Type: "chat.message"})
	h.publishUser("member", wire{Type: "rooms.changed"})
	private, public, refresh := <-member.send, <-member.send, <-member.send
	if !h.canDeliver(member, private) {
		t.Fatal("authorized queued event unexpectedly denied")
	}
	h.unsubscribeUser("private", "member")
	if h.canDeliver(member, private) {
		t.Fatal("private queued event survived revocation")
	}
	if !h.canDeliver(member, public) || !h.canDeliver(member, refresh) {
		t.Fatal("revocation discarded unrelated public and account events")
	}
	encoded, err := json.Marshal(private)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if _, exists := fields["audienceRoom"]; exists {
		t.Fatal("internal room audience leaked into wire JSON")
	}
	member.revoked.Store(true)
	if h.canDeliver(member, refresh) {
		t.Fatal("revoked session received account event")
	}
}

func TestGroupRemovalQueuesAccountRefreshAfterUnsubscriptionIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 2)
	owner, member := users[0], users[1]
	socialFriend(t, s, owner.ID, member.ID)
	fallback, err := s.CreateCommunity(owner.ID, "Fallback rooms", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.AddCommunityMember(fallback.ID, owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	group, err := s.CreateGroup(owner.ID, "Removed group", []string{member.ID})
	if err != nil {
		t.Fatal(err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost"})
	ownerCookie, _ := issueAccountSession(t, a, owner)
	memberCookie, _ := issueAccountSession(t, a, member)
	watchers := map[string]*realtimeClient{}
	for _, user := range []User{owner, member} {
		rooms, listErr := s.ListRooms(user.ID)
		if listErr != nil {
			t.Fatal(listErr)
		}
		watcher := &realtimeClient{user: user.ID, send: make(chan wire, 64)}
		a.Realtime.add(watcher, rooms, nil)
		watchers[user.ID] = watcher
	}
	signal := &client{user: member.ID, peer: member.ID, send: make(chan wire, 64)}
	a.Hub.add(group.ID, signal)
	// Delay delivery until removal completes, matching a writer blocked by the
	// membership mutation. Old room content must be dropped, but the account
	// refresh must survive so the client can select its remaining conversation.
	a.Realtime.publishRoom(group.ID, wire{Type: "chat.message", Payload: json.RawMessage(`{"body":"queued private group message"}`)})
	accountHTTP(t, a, ownerCookie, "DELETE", "/rooms/"+group.ID+"/members/"+member.ID, "", 200)
	removed := watchers[member.ID]
	blocked, refreshes := 0, 0
	for len(removed.send) > 0 {
		message := <-removed.send
		if !a.Realtime.canDeliver(removed, message) {
			blocked++
			continue
		}
		encoded, marshalErr := json.Marshal(message)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if string(encoded) != `{"type":"rooms.changed"}` || message.audienceRoom != "" {
			t.Fatalf("removed member received room metadata or content: %s", encoded)
		}
		refreshes++
	}
	if blocked < 2 || refreshes != 1 {
		t.Fatalf("queued removal events: blocked=%d account refreshes=%d, want private events blocked and one refresh", blocked, refreshes)
	}
	if a.Realtime.canPublishRoom(removed, group.ID) || !signal.revoked.Load() {
		t.Fatal("removed member retained a room subscription or call")
	}
	if !a.Realtime.canPublishRoom(removed, fallback.Channels[0].ID) {
		t.Fatal("unrelated fallback channel was unsubscribed")
	}
	remainingRefreshes := 0
	remaining := watchers[owner.ID]
	for len(remaining.send) > 0 {
		message := <-remaining.send
		if message.Type == "rooms.changed" && a.Realtime.canDeliver(remaining, message) && message.audienceRoom == group.ID {
			remainingRefreshes++
		}
	}
	if remainingRefreshes != 1 {
		t.Fatal("remaining member did not receive the room-scoped refresh")
	}
	for _, path := range []string{"/rooms/" + group.ID, "/rooms/" + group.ID + "/messages"} {
		response := accountHTTP(t, a, memberCookie, "GET", path, "", 403)
		var denied struct {
			Error apiError `json:"error"`
		}
		if err = json.Unmarshal(response.Body.Bytes(), &denied); err != nil || denied.Error.Code != "not_a_member" || denied.Error.Message != "room membership required" {
			t.Fatalf("removed room denial: %s %v", response.Body, err)
		}
	}
	response := accountHTTP(t, a, memberCookie, "GET", "/rooms", "", 200)
	var listing struct {
		Rooms []Room `json:"rooms"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Rooms) != 1 || listing.Rooms[0].ID != fallback.Channels[0].ID {
		t.Fatalf("room reload did not retain only the fallback channel: %+v", listing.Rooms)
	}
}

func TestCustomRolesAndPrivateChannelAuthorizationIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 5)
	owner, admin, member, outsider := users[0], users[1], users[2], users[3]
	c, err := s.CreateCommunity(owner.ID, "ACL squad", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []User{admin, member} {
		socialFriend(t, s, owner.ID, user.ID)
		if err = s.AddCommunityMember(c.ID, owner.ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.SetCommunityRole(c.ID, owner.ID, admin.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	private, err := s.CreateChannelWithPrivacy(c.ID, owner.ID, "secret", "", "hybrid", true)
	if err != nil {
		t.Fatal(err)
	}
	message, err := s.WriteMessage(private.ID, owner.ID, "", "classified squad plans", "")
	if err != nil {
		t.Fatal(err)
	}
	attachment := MessageAttachment{ID: "aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa", Filename: "plans.txt", ContentType: "text/plain", SizeBytes: 12}
	if err = s.SavePendingAttachment(private.ID, owner.ID, "messages/secret-plans", attachment); err != nil {
		t.Fatal(err)
	}
	if err = s.CompletePendingAttachment(attachment.ID, private.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.SendMessage(private.ID, owner.ID, "Private file", "", "aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa", []string{attachment.ID}); err != nil {
		t.Fatal(err)
	}
	for _, user := range []User{member, outsider} {
		if _, err = s.RoomForMember(private.ID, user.ID); err == nil {
			t.Fatalf("%s read private room", user.Name)
		}
		if err = s.RoomPermission(private.ID, user.ID, "join_voice"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("private voice: %v", err)
		}
		if _, _, err = s.AttachmentForMember(private.ID, user.ID, attachment.ID); err == nil {
			t.Fatal("private attachment leaked")
		}
		page, searchErr := s.SearchMessages(user.ID, "", "", "classified", "", 20)
		if searchErr != nil || len(page.Messages) != 0 {
			t.Fatalf("private search leaked: %+v %v", page, searchErr)
		}
		page, historyErr := s.MessagePage(private.ID, user.ID, "", 20)
		if historyErr == nil && len(page.Messages) > 0 {
			t.Fatal("private history leaked")
		}
		if _, err = s.ThreadPage(private.ID, user.ID, message.ID, "", nil, 20); err == nil {
			t.Fatal("private thread root leaked")
		}
	}
	role, err := s.SaveCustomRole(c.ID, owner.ID, "", CustomRole{Name: "Squad", Color: "#34d399", Permissions: map[string]bool{"pin_messages": true}})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetMemberCustomRoles(c.ID, owner.ID, member.ID, []string{role.ID}); err != nil {
		t.Fatal(err)
	}
	access := ChannelAccess{IsPrivate: true, Overrides: []ChannelOverride{{SubjectKey: role.ID, Permissions: map[string]string{"read": "allow"}}}}
	if err = s.SetChannelAccess(c.ID, owner.ID, owner.ID, access); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unrelated channel accepted: %v", err)
	}
	if err = s.SetChannelAccess(c.ID, private.ID, owner.ID, access); err != nil {
		t.Fatal(err)
	}
	memberRoom, err := s.RoomForMember(private.ID, member.ID)
	if err != nil || !memberRoom.IsPrivate || !memberRoom.Permissions.Read || !memberRoom.Permissions.PinMessages || !memberRoom.Permissions.JoinVoice {
		t.Fatalf("resolved custom permissions: %+v %v", memberRoom, err)
	}
	if _, _, err = s.AttachmentForMember(private.ID, member.ID, attachment.ID); err != nil {
		t.Fatalf("authorized published attachment unavailable: %v", err)
	}
	if _, err = s.PinMessage(private.ID, member.ID, message.ID, false); err != nil {
		t.Fatalf("custom role did not grant pins: %v", err)
	}
	if err = s.SetMemberCustomRoles(c.ID, admin.ID, admin.ID, []string{role.ID}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("self assignment allowed: %v", err)
	}
	if err = s.SetMemberCustomRoles(c.ID, admin.ID, owner.ID, []string{role.ID}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("lower role altered owner: %v", err)
	}
	if _, err = s.SaveCustomRole(c.ID, member.ID, "", CustomRole{Name: "Escalation", Color: "#64748b"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member created role: %v", err)
	}
	access.Overrides = append(access.Overrides, ChannelOverride{SubjectKey: "member", Permissions: map[string]string{"read": "deny", "post": "deny", "join_voice": "deny"}}, ChannelOverride{SubjectKey: "everyone", Permissions: map[string]string{"read": "deny"}})
	if err = s.SetChannelAccess(c.ID, private.ID, owner.ID, access); err != nil {
		t.Fatal(err)
	}
	if _, err = s.RoomForMember(private.ID, member.ID); err == nil {
		t.Fatal("custom allow bypassed matching deny")
	}
	if _, _, err = s.AttachmentForMember(private.ID, member.ID, attachment.ID); err == nil {
		t.Fatal("published attachment survived read revocation")
	}
	for _, user := range []User{owner, admin} {
		if _, err = s.RoomForMember(private.ID, user.ID); err != nil {
			t.Fatalf("administrator locked out: %v", err)
		}
	}
	other, err := s.CreateCommunity(outsider.ID, "Other", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := s.SaveCustomRole(other.ID, outsider.ID, "", CustomRole{Name: "Foreign", Color: "#64748b"})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetMemberCustomRoles(c.ID, owner.ID, member.ID, []string{foreign.ID}); !errors.Is(err, ErrInvalidPermissions) {
		t.Fatalf("cross-community assignment allowed: %v", err)
	}
	if err = s.SetChannelAccess(c.ID, private.ID, owner.ID, ChannelAccess{Overrides: []ChannelOverride{{SubjectKey: foreign.ID, Permissions: map[string]string{"read": "allow"}}}}); !errors.Is(err, ErrInvalidPermissions) {
		t.Fatalf("cross-community override allowed: %v", err)
	}
	unchanged, err := s.ChannelAccess(c.ID, private.ID, owner.ID)
	if err != nil || !unchanged.IsPrivate || len(unchanged.Overrides) != 3 {
		t.Fatalf("invalid ACL mutation was not atomic: %+v %v", unchanged, err)
	}
	if err = s.SetChannelAccess(c.ID, private.ID, owner.ID, ChannelAccess{IsPrivate: true, Overrides: []ChannelOverride{{SubjectKey: role.ID, Permissions: map[string]string{"read": "allow"}}}}); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteCustomRole(c.ID, owner.ID, role.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.RoomForMember(private.ID, member.ID); err == nil {
		t.Fatal("deleted role retained private access")
	}
	roster, err := s.CommunityMembers(c.ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range roster {
		if item.User.ID == member.ID && len(item.CustomRoleIDs) > 0 {
			t.Fatal("deleted role assignment survived")
		}
	}
}

func TestRoleDefaultsOverridesAnnouncementsAndLiveRevocationIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 2)
	owner, member := users[0], users[1]
	c, err := s.CreateCommunity(owner.ID, "Voice squad", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	room := c.Channels[0]
	socialFriend(t, s, owner.ID, member.ID)
	if err = s.AddCommunityMember(c.ID, owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	role, err := s.SaveCustomRole(c.ID, owner.ID, "", CustomRole{Name: "Quiet", Color: "#64748b", Permissions: map[string]bool{"post": false, "join_voice": false}})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetMemberCustomRoles(c.ID, owner.ID, member.ID, []string{role.ID}); err != nil {
		t.Fatal(err)
	}
	info, err := s.RoomForMember(room.ID, member.ID)
	if err != nil || info.Permissions.Post || info.Permissions.JoinVoice {
		t.Fatalf("role default restrictions: %+v %v", info, err)
	}
	if _, err = s.WriteMessage(room.ID, member.ID, "", "quiet bypass", ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("default posting deny bypassed: %v", err)
	}
	access := ChannelAccess{Overrides: []ChannelOverride{{SubjectKey: role.ID, Permissions: map[string]string{"post": "allow", "join_voice": "allow"}}}}
	if err = s.SetChannelAccess(c.ID, room.ID, owner.ID, access); err != nil {
		t.Fatal(err)
	}
	if err = s.RoomPermission(room.ID, member.ID, "join_voice"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.WriteMessage(room.ID, member.ID, "", "channel allowance", ""); err != nil {
		t.Fatal(err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost"})
	cookie, _ := issueAccountSession(t, a, owner)
	rooms, err := s.ListRooms(member.ID)
	if err != nil {
		t.Fatal(err)
	}
	watcher := &realtimeClient{user: member.ID, send: make(chan wire, 64)}
	a.Realtime.add(watcher, rooms, nil)
	signal := &client{user: member.ID, peer: member.ID, send: make(chan wire, 64)}
	a.Hub.add(room.ID, signal)
	// Posting/voice can be denied without hiding history. Only the call is revoked.
	body := `{"is_private":false,"overrides":[{"subject_key":"member","permissions":{"join_voice":"deny"}}]}`
	accountHTTP(t, a, cookie, "PUT", "/communities/"+c.ID+"/channels/"+room.ID+"/permissions", body, 200)
	if !signal.revoked.Load() || !a.Realtime.canPublishRoom(watcher, room.ID) {
		t.Fatal("voice denial must revoke call and preserve readable subscription")
	}
	accountHTTP(t, a, cookie, "PUT", "/communities/"+c.ID+"/channels/"+room.ID+"/permissions", `{"is_private":true,"overrides":[]}`, 200)
	if a.Realtime.canPublishRoom(watcher, room.ID) {
		t.Fatal("read revocation retained realtime subscription")
	}
	encoded, _ := json.Marshal(ChannelAccess{IsPrivate: true, Overrides: []ChannelOverride{{SubjectKey: role.ID, Permissions: map[string]string{"read": "allow", "join_voice": "allow", "post": "allow"}}}})
	accountHTTP(t, a, cookie, "PUT", "/communities/"+c.ID+"/channels/"+room.ID+"/permissions", string(encoded), 200)
	if !a.Realtime.canPublishRoom(watcher, room.ID) {
		t.Fatal("role allowance did not restore realtime subscription")
	}
	news := "announcement"
	if _, err = s.UpdateChannel(c.ID, room.ID, owner.ID, ChannelUpdate{ChannelType: &news}); err != nil {
		t.Fatal(err)
	}
	if err = s.RoomPermission(room.ID, member.ID, "post"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("announcement custom posting bypass: %v", err)
	}
	for _, user := range []User{owner, member} {
		if err = s.RoomPermission(room.ID, user.ID, "join_voice"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("announcement voice bypass: %v", err)
		}
	}
	accountHTTP(t, a, cookie, "DELETE", "/communities/"+c.ID+"/roles/"+role.ID, "", 200)
	if a.Realtime.canPublishRoom(watcher, room.ID) {
		t.Fatal("role deletion retained private realtime subscription")
	}
}

func TestPrivateChannelInvitationDoesNotGrantAccessIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 2)
	owner, member := users[0], users[1]
	c, err := s.CreateCommunity(owner.ID, "Invite squad", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	private, err := s.CreateChannelWithPrivacy(c.ID, owner.ID, "private", "", "hybrid", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateInvite(private.ID, owner.ID, "private-channel-invite", nil, 2); err != nil {
		t.Fatal(err)
	}
	joined, added, err := s.RedeemInvite("private-channel-invite", member.ID)
	if err != nil || !added || joined.ID != c.Channels[0].ID {
		t.Fatalf("expected public sibling from invitation: %+v %t %v", joined, added, err)
	}
	if _, err = s.RoomForMember(private.ID, member.ID); err == nil {
		t.Fatal("invitation granted private access")
	}
	closed, err := s.CreateCommunity(owner.ID, "Closed squad", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetChannelAccess(closed.ID, closed.Channels[0].ID, owner.ID, ChannelAccess{IsPrivate: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateInvite(closed.Channels[0].ID, owner.ID, "closed-channel-invite", nil, 2); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.RedeemInvite("closed-channel-invite", member.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("entirely private invitation: %v", err)
	}
	if _, err = s.CommunityForMember(closed.ID, member.ID); err == nil {
		t.Fatal("failed invitation left hidden membership")
	}
}

func TestModeratorRemovalRevokesChannelsHiddenToModeratorIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 3)
	owner, moderator, member := users[0], users[1], users[2]
	c, err := s.CreateCommunity(owner.ID, "Hidden revocation", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []User{moderator, member} {
		socialFriend(t, s, owner.ID, user.ID)
		if err = s.AddCommunityMember(c.ID, owner.ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.SetCommunityRole(c.ID, owner.ID, moderator.ID, "moderator"); err != nil {
		t.Fatal(err)
	}
	private, err := s.CreateChannelWithPrivacy(c.ID, owner.ID, "hidden", "", "hybrid", true)
	if err != nil {
		t.Fatal(err)
	}
	role, err := s.SaveCustomRole(c.ID, owner.ID, "", CustomRole{Name: "Private guests", Color: "#64748b"})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetMemberCustomRoles(c.ID, owner.ID, member.ID, []string{role.ID}); err != nil {
		t.Fatal(err)
	}
	if err = s.SetChannelAccess(c.ID, private.ID, owner.ID, ChannelAccess{IsPrivate: true, Overrides: []ChannelOverride{{SubjectKey: role.ID, Permissions: map[string]string{"read": "allow"}}}}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.RoomForMember(private.ID, moderator.ID); err == nil {
		t.Fatal("moderator should not see private target channel")
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost"})
	cookie, _ := issueAccountSession(t, a, moderator)
	rooms, err := s.ListRooms(member.ID)
	if err != nil {
		t.Fatal(err)
	}
	watcher := &realtimeClient{user: member.ID, send: make(chan wire, 64)}
	a.Realtime.add(watcher, rooms, nil)
	signal := &client{user: member.ID, peer: member.ID, send: make(chan wire, 64)}
	a.Hub.add(private.ID, signal)
	accountHTTP(t, a, cookie, "DELETE", "/communities/"+c.ID+"/members/"+member.ID, "", 200)
	if a.Realtime.canPublishRoom(watcher, private.ID) || !signal.revoked.Load() {
		t.Fatal("moderator removal failed to revoke hidden sibling")
	}
}

func TestAnnouncementConversionClearsWatchTogetherIntegration(t *testing.T) {
	s := conversationTestStore(t)
	owner := socialUsers(t, s, 1)[0]
	c, err := s.CreateCommunity(owner.ID, "Watch conversion", "", "movies")
	if err != nil {
		t.Fatal(err)
	}
	room := c.Channels[0].ID
	id, err := randomAttachmentID()
	if err != nil {
		t.Fatal(err)
	}
	attachment := MessageAttachment{ID: id, Filename: "movie.mp4", ContentType: "video/mp4", SizeBytes: 100}
	if err = s.SavePendingAttachment(room, owner.ID, "activities/watch-conversion/"+id, attachment); err != nil {
		t.Fatal(err)
	}
	if err = s.CompletePendingAttachment(id, room); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.SendMessage(room, owner.ID, "Watch this", "", "", []string{id}); err != nil {
		t.Fatal(err)
	}
	watch, err := s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "start", AttachmentID: id})
	if err != nil || watch == nil {
		t.Fatalf("watch setup: %+v %v", watch, err)
	}
	announcement := "announcement"
	if _, err = s.UpdateChannel(c.ID, room, owner.ID, ChannelUpdate{ChannelType: &announcement}); err != nil {
		t.Fatal(err)
	}
	hybrid := "hybrid"
	if _, err = s.UpdateChannel(c.ID, room, owner.ID, ChannelUpdate{ChannelType: &hybrid}); err != nil {
		t.Fatal(err)
	}
	activities, err := s.ChannelActivities(room, owner.ID)
	if err != nil || activities.Watch != nil {
		t.Fatalf("stale watch revived after hybrid restoration: %+v %v", activities.Watch, err)
	}
}
