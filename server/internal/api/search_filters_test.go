package api

import (
	"context"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestMessageSearchFilters(t *testing.T) {
	for _, query := range []string{"", "q=x", "q=ab%00", "q=ab%FF", "kind=unknown", "from=2026-10-11", "from=2026-10-12T00:00:00Z&to=2026-10-11T00:00:00Z", "room_id=broken", "kind=video&before_id=search:MA"} {
		if _, err := parseMessageSearchFilters(httptest.NewRequest("GET", "/?"+query, nil)); err == nil {
			t.Fatalf("accepted invalid filters %q", query)
		}
	}
	r := httptest.NewRequest("GET", "/?kind=video&from="+url.QueryEscape("2026-10-11T00:00:00-06:00")+"&to="+url.QueryEscape("2026-10-12T00:00:00-06:00"), nil)
	f, err := parseMessageSearchFilters(r)
	if err != nil || f.Query != "" || f.From == nil || f.From.Format(time.RFC3339) != "2026-10-11T06:00:00Z" || f.To.Format(time.RFC3339) != "2026-10-12T06:00:00Z" {
		t.Fatalf("UTC bounds: %+v %v", f, err)
	}
	for _, sequence := range []int64{1, 2147483648, 9223372036854775806} {
		got, err := decodeSearchCursor(encodeSearchCursor(sequence))
		if err != nil || got != sequence {
			t.Fatalf("cursor round trip: %d %v", got, err)
		}
	}
}

func TestSearchVisibleLinks(t *testing.T) {
	for _, body := range []string{"https://example.test/a", "[link](https://example.test/a)", "HTTPS://example.test"} {
		if !searchHasVisibleLink(body) {
			t.Fatalf("missed visible link: %s", body)
		}
	}
	for _, body := range []string{"plain text", "`https://example.test`", "```go\nhttps://example.test\n```", "||https://example.test||", "https://user:password@example.test", "https://"} {
		if searchHasVisibleLink(body) {
			t.Fatalf("accepted hidden/unsafe link: %s", body)
		}
	}
}

func TestSearchDateAttachmentsAndAccessIntegration(t *testing.T) {
	s := conversationTestStore(t)
	ctx := context.Background()
	users := socialUsers(t, s, 3)
	owner, member, outsider := users[0], users[1], users[2]
	community, err := s.CreateCommunity(owner.ID, "Filtered search", "", "hangout")
	if err != nil {
		t.Fatal(err)
	}
	room := community.Channels[0].ID
	socialFriend(t, s, owner.ID, member.ID)
	if err = s.AddCommunityMember(community.ID, owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	post := func(body string, types ...string) Message {
		t.Helper()
		ids := []string{}
		for _, contentType := range types {
			id, idErr := randomAttachmentID()
			if idErr != nil {
				t.Fatal(idErr)
			}
			if err = s.SavePendingAttachment(room, owner.ID, "search/test/"+id, MessageAttachment{ID: id, Filename: "fixture", ContentType: contentType, SizeBytes: 100}); err != nil {
				t.Fatal(err)
			}
			if err = s.CompletePendingAttachment(id, room); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		message, _, sendErr := s.SendMessage(room, owner.ID, body, "", "", ids)
		if sendErr != nil {
			t.Fatal(sendErr)
		}
		return message
	}
	first := post("range start", "image/png", "image/jpeg", "application/pdf")
	end := post("range end", "video/mp4")
	quarantined := post("quarantined", "image/png")
	from := time.Date(2026, 10, 11, 6, 0, 0, 0, time.UTC)
	to := from.Add(24 * time.Hour)
	if _, err = s.DB.Exec(ctx, `UPDATE messages SET created_at=CASE WHEN id=$1 THEN $3::timestamptz ELSE $4::timestamptz END WHERE id IN ($1,$2)`, first.ID, end.ID, from, to); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(ctx, `UPDATE message_attachments SET scan_state='pending' WHERE message_id=$1`, quarantined.ID); err != nil {
		t.Fatal(err)
	}
	page, err := s.SearchMessagesFiltered(ctx, member.ID, MessageSearchFilters{RoomID: room, Kind: "image", From: &from, To: &to, Limit: 10})
	if err != nil || len(page.Messages) != 1 || page.Messages[0].ID != first.ID || len(page.Messages[0].Attachments) != 3 {
		t.Fatalf("deduplicated published images within [from,to): %+v %v", page, err)
	}
	page, err = s.SearchMessagesFiltered(ctx, member.ID, MessageSearchFilters{RoomID: room, Kind: "video", From: &from, To: &to, Limit: 10})
	if err != nil || len(page.Messages) != 0 {
		t.Fatalf("exclusive end included: %+v %v", page, err)
	}
	page, err = s.SearchMessagesFiltered(ctx, member.ID, MessageSearchFilters{RoomID: room, Query: "quarantined", Limit: 10})
	if err != nil || len(page.Messages) != 1 || len(page.Messages[0].Attachments) != 0 {
		t.Fatalf("text projection leaked a quarantined file: %+v %v", page, err)
	}
	page, err = s.SearchMessagesFiltered(ctx, outsider.ID, MessageSearchFilters{RoomID: room, Kind: "file", Limit: 10})
	if err != nil || len(page.Messages) != 0 {
		t.Fatalf("outsider search: %+v %v", page, err)
	}
	page, err = s.SearchMessagesFiltered(ctx, member.ID, MessageSearchFilters{RoomID: room, Kind: "file", Limit: 1})
	if err != nil || len(page.Messages) != 1 || page.Messages[0].ID != first.ID {
		t.Fatalf("document filter: %+v %v", page, err)
	}
	if err = s.RemoveCommunityMember(community.ID, owner.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	page, err = s.SearchMessagesFiltered(ctx, member.ID, MessageSearchFilters{RoomID: room, Kind: "image", Limit: 10})
	if err != nil || len(page.Messages) != 0 {
		t.Fatalf("revoked member search: %+v %v", page, err)
	}
}

func TestSearchLinkPaginationSurvivesDeletionIntegration(t *testing.T) {
	s := conversationTestStore(t)
	ctx := context.Background()
	owner := socialUsers(t, s, 1)[0]
	room, err := s.CreateRoom(owner.ID, "Link search")
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"https://example.test/oldest", "https://example.test/middle", "https://example.test/newest", "`https://example.test/code`", "||https://example.test/spoiler||", "https://user:password@example.test"} {
		if _, _, err = s.SendMessage(room.ID, owner.ID, body, "", "", nil); err != nil {
			t.Fatal(err)
		}
	}
	f := MessageSearchFilters{RoomID: room.ID, Kind: "link", Limit: 1}
	page, err := s.SearchMessagesFiltered(ctx, owner.ID, f)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].Body != "https://example.test/newest" || page.BeforeID == "" {
		t.Fatalf("first visible link: %+v %v", page, err)
	}
	if _, err = s.DB.Exec(ctx, `DELETE FROM messages WHERE id=$1`, page.Messages[0].ID); err != nil {
		t.Fatal(err)
	}
	f.BeforeID = page.BeforeID
	page, err = s.SearchMessagesFiltered(ctx, owner.ID, f)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].Body != "https://example.test/middle" || page.BeforeID == "" {
		t.Fatalf("cursor after deletion: %+v %v", page, err)
	}
	f.BeforeID = page.BeforeID
	page, err = s.SearchMessagesFiltered(ctx, owner.ID, f)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].Body != "https://example.test/oldest" || page.BeforeID != "" {
		t.Fatalf("last link: %+v %v", page, err)
	}
}
