package api

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestYouTubeAndAttachmentLegacyCompatibilityIntegration(t *testing.T) {
	s, room, users := youtubeCommunity(t)
	owner := users[0]
	attachment, err := randomAttachmentID()
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SavePendingAttachment(room, owner.ID, "youtube-test/"+attachment, MessageAttachment{ID: attachment, Filename: "match.mp4", ContentType: "video/mp4", SizeBytes: 100}); err != nil {
		t.Fatal(err)
	}
	if err = s.CompletePendingAttachment(attachment, room); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.SendMessage(room, owner.ID, "Video", "", "", []string{attachment}); err != nil {
		t.Fatal(err)
	}
	file, err := s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "start", AttachmentID: attachment})
	if err != nil || file.SourceKind != "attachment" || file.PlaybackID == "" {
		t.Fatalf("file start %+v %v", file, err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "https://app.bettrcomms.com", YouTubePlayerOrigin: "https://player.bettrcomms.com"})
	read := func(capability string) *WatchTogetherState {
		t.Helper()
		r := httptest.NewRequest("GET", "https://app.bettrcomms.com/api/v1/rooms/"+room+"/activities"+capability, nil)
		w := httptest.NewRecorder()
		a.routeActivityFeatures(w, r, []string{"rooms", room, "activities"}, owner)
		if w.Code != 200 {
			t.Fatalf("activity read %d %s", w.Code, w.Body.String())
		}
		var v ChannelActivitySnapshot
		if json.Unmarshal(w.Body.Bytes(), &v) != nil {
			t.Fatal("invalid activity response")
		}
		return v.Watch
	}
	legacy := read("")
	if legacy == nil || legacy.Attachment.ID != attachment {
		t.Fatal("legacy file shape changed")
	}
	if err = s.SetWatchViewing(room, owner.ID, "11111111-1111-4111-8111-111111111111", true); err != nil {
		t.Fatal(err)
	}
	youtube, err := s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "start", SourceKind: "youtube", VideoURL: "https://youtu.be/M7lc1UVf-VE", YouTubeID: "M7lc1UVf-VE", Title: "Video", WatchSources: true, Revision: file.Revision, PlaybackID: file.PlaybackID})
	if err != nil || youtube.PlaybackID == file.PlaybackID {
		t.Fatalf("YouTube replace %+v %v", youtube, err)
	}
	if read("") != nil {
		t.Fatal("legacy client received unsupported source")
	}
	modern := read("?watch_sources=file,youtube")
	if modern == nil || modern.YouTube.ID != "M7lc1UVf-VE" {
		t.Fatal("modern source hidden")
	}
	if _, err = s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "heartbeat", Revision: youtube.Revision}); !errors.Is(err, ErrConflict) {
		t.Fatalf("legacy client altered YouTube %v", err)
	}
	file, err = s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "start", AttachmentID: attachment, WatchSources: true, Revision: youtube.Revision, PlaybackID: youtube.PlaybackID})
	if err != nil || file.SourceKind != "attachment" || file.Attachment.ID != attachment || file.PlaybackID == youtube.PlaybackID {
		t.Fatalf("return to file %+v %v", file, err)
	}
	if _, err = s.ChangeWatchTogether(room, owner.ID, WatchTogetherCommand{Action: "seek", WatchSources: true, PlaybackID: youtube.PlaybackID, Revision: file.Revision, PositionSeconds: 2}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale YouTube callback changed file %v", err)
	}
	if !strings.Contains(playerJavaScript, "event.source!==window.parent") || !strings.Contains(playerJavaScript, "credentials:'omit'") {
		t.Fatal("bridge origin/credential restrictions missing")
	}
}
