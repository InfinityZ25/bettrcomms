package api

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestCommunityHierarchyAndAnnouncementsIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 5)
	owner, admin, moderator, member, outsider := users[0], users[1], users[2], users[3], users[4]
	c, err := s.CreateCommunity(owner.ID, "Friends", "Our evening hangout", "general")
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Channels) != 1 || c.Channels[0].ID != c.ID || c.Channels[0].ChannelType != "hybrid" {
		t.Fatalf("initial channel: %+v", c)
	}
	general := c.Channels[0]
	for _, user := range []User{admin, moderator, member} {
		socialFriend(t, s, owner.ID, user.ID)
		if err = s.AddCommunityMember(c.ID, owner.ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.SetCommunityRole(c.ID, owner.ID, admin.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetCommunityRole(c.ID, admin.ID, moderator.ID, "moderator"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetCommunityRole(c.ID, admin.ID, member.ID, "admin"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("admin assigned an equal role: %v", err)
	}
	if err = s.SetCommunityRole(c.ID, moderator.ID, member.ID, "moderator"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator assigned a role: %v", err)
	}
	if err = s.RemoveCommunityMember(c.ID, moderator.ID, admin.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator removed admin: %v", err)
	}
	if _, err = s.CreateChannel(c.ID, moderator.ID, "forbidden", "", "hybrid"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator created channel: %v", err)
	}
	if err = s.SetSlowMode(general.ID, moderator.ID, 10); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator changed channel configuration: %v", err)
	}
	message, err := s.WriteMessage(general.ID, member.ID, "", "Keep this history", "")
	if err != nil {
		t.Fatal(err)
	}
	news, err := s.CreateChannel(c.ID, admin.ID, "announcements", "Plans for tonight", "announcement")
	if err != nil {
		t.Fatal(err)
	}
	memberNews, err := s.RoomForMember(news.ID, member.ID)
	if err != nil || memberNews.Permissions.Post || memberNews.Permissions.JoinVoice || memberNews.CommunityID == nil || *memberNews.CommunityID != c.ID {
		t.Fatalf("member announcement permissions: %+v %v", memberNews, err)
	}
	for _, user := range []User{member, moderator, outsider} {
		if _, err = s.WriteMessage(news.ID, user.ID, "", "Not allowed", ""); !errors.Is(err, ErrForbidden) {
			t.Fatalf("%s posted announcement: %v", user.Name, err)
		}
		if err = s.RoomPermission(news.ID, user.ID, "join_voice"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("%s joined announcement voice: %v", user.Name, err)
		}
	}
	if err = s.RoomPermission(news.ID, admin.ID, "join_voice"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("admin joined announcement voice: %v", err)
	}
	if _, err = s.WriteMessage(news.ID, admin.ID, "", "Tonight at eight", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = s.PinMessage(general.ID, moderator.ID, message.ID, false); err != nil {
		t.Fatalf("moderator pin: %v", err)
	}
	if _, err = s.PinMessage(general.ID, member.ID, message.ID, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member removed moderator pin: %v", err)
	}
	if _, err = s.ReorderChannels(c.ID, admin.ID, []string{news.ID, general.ID}); err != nil {
		t.Fatal(err)
	}
	ordered, err := s.CommunityForMember(c.ID, member.ID)
	if err != nil || len(ordered.Channels) != 2 || ordered.Channels[0].ID != news.ID {
		t.Fatalf("ordered channels: %+v %v", ordered, err)
	}
	page, err := s.MessagePage(general.ID, member.ID, "", 10)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].ID != message.ID {
		t.Fatalf("history changed: %+v %v", page, err)
	}
	if err = s.ModerateMember(general.ID, moderator.ID, admin.ID, "ban", "No escalation", 0); !errors.Is(err, ErrForbidden) {
		t.Fatalf("moderator banned admin: %v", err)
	}
	if err = s.ModerateMember(general.ID, moderator.ID, member.ID, "timeout", "Pause posting", 60); err != nil {
		t.Fatal(err)
	}
	if err = s.CheckPosting(general.ID, member.ID); err == nil {
		t.Fatal("parent timeout did not restrict child")
	}
	if err = s.ModerateMember(general.ID, moderator.ID, member.ID, "clear_timeout", "", 0); err != nil {
		t.Fatal(err)
	}
	if err = s.CheckPosting(general.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteChannel(c.ID, news.ID, admin.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteChannel(c.ID, general.ID, owner.ID); !errors.Is(err, ErrLastChannel) {
		t.Fatalf("deleted last channel: %v", err)
	}
	if err = s.TransferCommunityOwner(context.Background(), c.ID, owner.ID, admin.ID); err != nil {
		t.Fatal(err)
	}
	transferred, err := s.RoomForMember(general.ID, owner.ID)
	if err != nil || transferred.OwnerID != admin.ID || transferred.Role != "admin" {
		t.Fatalf("ownership did not reach child: %+v %v", transferred, err)
	}
	if err = s.DeleteCommunity(c.ID, owner.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("former owner deleted community: %v", err)
	}
}

func TestCommunityInvitationAndRevocationIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 2)
	owner, member := users[0], users[1]
	c, err := s.CreateCommunity(owner.ID, "Friends", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateChannel(c.ID, owner.ID, "games", "", "hybrid")
	if err != nil {
		t.Fatal(err)
	}
	token := "whole-community-invitation"
	if _, err = s.CreateInvite(second.ID, owner.ID, token, nil, 2); err != nil {
		t.Fatal(err)
	}
	joined, added, err := s.RedeemInvite(token, member.ID)
	if err != nil || !added || joined.ID != second.ID {
		t.Fatalf("invitation join: %+v %t %v", joined, added, err)
	}
	for _, room := range []Room{c.Channels[0], second} {
		if _, err = s.RoomForMember(room.ID, member.ID); err != nil {
			t.Fatalf("invitation did not grant sibling %s: %v", room.Name, err)
		}
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "http://localhost"})
	cookie, _ := issueAccountSession(t, a, owner)
	memberRooms, _ := s.ListRooms(member.ID)
	watcher := &realtimeClient{user: member.ID, send: make(chan wire, 32)}
	a.Realtime.add(watcher, memberRooms, nil)
	signals := []*client{}
	for _, room := range memberRooms {
		signal := &client{user: member.ID, peer: member.ID, send: make(chan wire, 32)}
		a.Hub.add(room.ID, signal)
		signals = append(signals, signal)
	}
	accountHTTP(t, a, cookie, "PUT", "/rooms/"+second.ID+"/moderation/bans/"+member.ID, `{"reason":"Repeated disruption"}`, 200)
	for i, room := range memberRooms {
		if _, err = s.RoomForMember(room.ID, member.ID); err == nil {
			t.Fatal("banned member retained sibling access")
		}
		if a.Realtime.canPublishRoom(watcher, room.ID) || !signals[i].revoked.Load() {
			t.Fatal("ban retained realtime or signaling access")
		}
	}
	if _, _, err = s.RedeemInvite(token, member.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("invitation bypassed parent ban: %v", err)
	}
	accountHTTP(t, a, cookie, "DELETE", "/rooms/"+second.ID+"/moderation/bans/"+member.ID, "", 200)
	if _, _, err = s.RedeemInvite(token, member.ID); err != nil {
		t.Fatal(err)
	}
	listed := accountHTTP(t, a, cookie, "GET", "/communities/"+c.ID, "", 200)
	var response struct {
		Community Community `json:"community"`
	}
	if err = json.Unmarshal(listed.Body.Bytes(), &response); err != nil || len(response.Community.Channels) != 2 {
		t.Fatalf("community API contract: %+v %v", response, err)
	}
}

func TestCommunityUploadRechecksAnnouncementAndRoleIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 2)
	owner, member := users[0], users[1]
	c, err := s.CreateCommunity(owner.ID, "Friends", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	socialFriend(t, s, owner.ID, member.ID)
	if err = s.AddCommunityMember(c.ID, owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	room := c.Channels[0].ID
	attachment := MessageAttachment{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Filename: "clip.mp4", ContentType: "video/mp4", SizeBytes: 100}
	if err = s.SavePendingAttachment(room, member.ID, "messages/community-upload", attachment); err != nil {
		t.Fatal(err)
	}
	announcement := "announcement"
	if _, err = s.UpdateChannel(c.ID, room, owner.ID, ChannelUpdate{ChannelType: &announcement}); err != nil {
		t.Fatal(err)
	}
	if err = s.CompletePendingAttachment(attachment.ID, room); !errors.Is(err, ErrForbidden) {
		t.Fatalf("upload completed after channel became read-only: %v", err)
	}
	if _, _, err = s.AttachmentForMember(room, member.ID, attachment.ID); err == nil {
		t.Fatal("revoked pending upload became readable")
	}
	if err = s.SetCommunityRole(c.ID, owner.ID, member.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	attachment.ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	if err = s.SavePendingAttachment(room, member.ID, "messages/community-demoted-upload", attachment); err != nil {
		t.Fatal(err)
	}
	if err = s.SetCommunityRole(c.ID, owner.ID, member.ID, "member"); err != nil {
		t.Fatal(err)
	}
	if err = s.CompletePendingAttachment(attachment.ID, room); !errors.Is(err, ErrForbidden) {
		t.Fatalf("upload completed after publisher demotion: %v", err)
	}
}

func TestCommunityAdministratorPostingExemptionIntegration(t *testing.T) {
	s := conversationTestStore(t)
	users := socialUsers(t, s, 3)
	owner, admin, member := users[0], users[1], users[2]
	c, err := s.CreateCommunity(owner.ID, "Friends", "", "general")
	if err != nil {
		t.Fatal(err)
	}
	room := c.Channels[0].ID
	for _, user := range []User{admin, member} {
		socialFriend(t, s, owner.ID, user.ID)
		if err = s.AddCommunityMember(c.ID, owner.ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.SetCommunityRole(c.ID, owner.ID, admin.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetSlowMode(room, owner.ID, 60); err != nil {
		t.Fatal(err)
	}
	if err = s.ModerateMember(room, owner.ID, admin.ID, "timeout", "Exemption fixture", 60); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"First administrator message", "Immediate administrator follow-up"} {
		if _, err = s.WriteMessage(room, admin.ID, "", body, ""); err != nil {
			t.Fatalf("administrator posting was restricted: %v", err)
		}
	}
	state, err := s.PostingState(room, admin.ID)
	if err != nil || state.RestrictedUntil != nil || state.NextPostAt != nil {
		t.Fatalf("administrator state exposed a restriction: %+v %v", state, err)
	}
	if _, err = s.WriteMessage(room, member.ID, "", "First member message", ""); err != nil {
		t.Fatal(err)
	}
	_, err = s.WriteMessage(room, member.ID, "", "Immediate member follow-up", "")
	var posting *PostingError
	if !errors.As(err, &posting) || posting.Code != "slow_mode" {
		t.Fatalf("member bypassed cooldown: %v", err)
	}
	if err = s.SetCommunityRole(c.ID, owner.ID, admin.ID, "member"); err != nil {
		t.Fatal(err)
	}
	if err = s.CheckPosting(room, admin.ID); !errors.As(err, &posting) || posting.Code != "posting_restricted" {
		t.Fatalf("demotion did not restore the existing restriction: %v", err)
	}
}
