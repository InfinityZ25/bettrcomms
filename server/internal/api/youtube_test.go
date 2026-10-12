package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestYouTubeURLsAndPlayerOrigins(t *testing.T) {
	for _, raw := range []string{"https://youtu.be/M7lc1UVf-VE?t=10", "https://www.youtube.com/watch?v=M7lc1UVf-VE&list=ignored", "https://m.youtube.com/shorts/M7lc1UVf-VE"} {
		id, err := canonicalYouTubeID(raw)
		if err != nil || id != "M7lc1UVf-VE" {
			t.Fatalf("valid URL %q: %s %v", raw, id, err)
		}
	}
	for _, raw := range []string{"http://youtube.com/watch?v=M7lc1UVf-VE", "https://youtube.com.evil.test/watch?v=M7lc1UVf-VE", "https://user@youtube.com/watch?v=M7lc1UVf-VE", "https://youtube.com:443/watch?v=M7lc1UVf-VE", "https://youtube.com/watch?v=short", "https://youtube.com/redirect?url=https://evil.test", "https://youtu.be/M7lc1UVf-VE/extra", "https://127.0.0.1/shorts/M7lc1UVf-VE"} {
		if _, err := canonicalYouTubeID(raw); err == nil {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
	for _, raw := range []string{"https://app.bettrcomms.com", "https://player.bettrcomms.com/path", "https://user@player.bettrcomms.com", "http://player.bettrcomms.com", "https://player.bettrcomms.com?x=1"} {
		if ValidateYouTubePlayerOrigin(raw, "https://app.bettrcomms.com") == nil {
			t.Fatalf("unsafe player origin %s", raw)
		}
	}
	if err := ValidateYouTubePlayerOrigin("https://player.bettrcomms.com", "https://app.bettrcomms.com"); err != nil {
		t.Fatal(err)
	}
}

type youtubeRoundTrip func(*http.Request) (*http.Response, error)

func (f youtubeRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestYouTubeMetadataFixedEndpointBoundedAndHTMLIgnored(t *testing.T) {
	calls := 0
	a := &API{HTTP: &http.Client{Transport: youtubeRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Scheme != "https" || r.URL.Host != "www.youtube.com" || r.URL.Path != "/oembed" || r.URL.Query().Get("url") != "https://www.youtube.com/watch?v=M7lc1UVf-VE" {
			t.Fatalf("unexpected metadata request %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"title":"Video title","html":"<script>steal()</script>"}`))}, nil
	})}}
	v, err := a.youtubeVideo(context.Background(), "https://youtu.be/M7lc1UVf-VE", "")
	if err != nil || v.Title != "Video title" || calls != 1 {
		t.Fatalf("metadata %+v %v", v, err)
	}
	if _, err = a.youtubeVideo(context.Background(), "https://evil.test/?video=M7lc1UVf-VE", ""); err == nil || calls != 1 {
		t.Fatal("invalid URL fetched metadata")
	}
	a.HTTP.Transport = youtubeRoundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://evil.test"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})
	v, err = a.youtubeVideo(context.Background(), "https://youtu.be/M7lc1UVf-VE", "My title")
	if err != nil || v.Title != "My title" {
		t.Fatalf("redirect did not preserve fallback: %+v %v", v, err)
	}
	a.HTTP.Transport = youtubeRoundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 32769)))}, nil
	})
	v, err = a.youtubeVideo(context.Background(), "https://youtu.be/M7lc1UVf-VE", "")
	if err != nil || v.Title != "YouTube · M7lc1UVf-VE" {
		t.Fatalf("oversized metadata: %+v %v", v, err)
	}
}
func TestYouTubeHelperRejectsAllCredentialRoutes(t *testing.T) {
	a := New(nil, Sessions{}, Config{AppURL: "https://app.bettrcomms.com", YouTubePlayerOrigin: "https://player.bettrcomms.com"})
	calls := 0
	handler := a.WithYouTubePlayerHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) }))
	for _, path := range []string{"/", "/api/v1/me", "/api/v1/auth/login", "/api/v1/events", "/anything.js"} {
		request := httptest.NewRequest("GET", "https://player.bettrcomms.com"+path, nil)
		request.Header.Set("Cookie", "bettercomms_session=must-never-be-resolved")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 404 || response.Header().Get("Set-Cookie") != "" || calls != 0 {
			t.Fatalf("helper routed private path %s: %d", path, response.Code)
		}
	}
	for _, path := range []string{"/player", "/player.js", "/healthz", "/player?opaque=1"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "https://player.bettrcomms.com"+path, nil))
		if response.Code != 200 || response.Header().Get("Set-Cookie") != "" || response.Header().Get("Referrer-Policy") != "strict-origin-when-cross-origin" {
			t.Fatalf("helper headers %s: %d", path, response.Code)
		}
		if path == "/player?opaque=1" && strings.Contains(response.Header().Get("Content-Security-Policy"), "frame-ancestors") {
			t.Fatal("opaque helper blocked opaque parent")
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "https://app.bettrcomms.com/api/v1/me", nil))
	if calls != 1 || response.Code != 204 {
		t.Fatal("helper intercepted application hostname")
	}
}
func youtubeCommunity(t *testing.T) (*PostgresStore, string, []User) {
	t.Helper()
	s := conversationTestStore(t)
	users := socialUsers(t, s, 4)
	community, err := s.CreateCommunity(users[0].ID, "YouTube friends", "", "movie")
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range users[1:3] {
		socialFriend(t, s, users[0].ID, user.ID)
		if err = s.AddCommunityMember(community.ID, users[0].ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	return s, community.Channels[0].ID, users
}
func TestYouTubeQueueVotingLeasesAndIdempotenceIntegration(t *testing.T) {
	s, room, users := youtubeCommunity(t)
	ctx := context.Background()
	device := []string{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"}
	for i, user := range users[:3] {
		if err := s.SetWatchViewing(room, user.ID, device[i], true); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SetWatchViewing(room, users[0].ID, "44444444-4444-4444-8444-444444444444", true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetWatchViewing(room, users[3].ID, device[0], true); !errors.Is(err, ErrForbidden) && !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider joined watch: %v", err)
	}
	first := YouTubeVideo{ID: "M7lc1UVf-VE", Title: "First"}
	second := YouTubeVideo{ID: "dQw4w9WgXcQ", Title: "Second"}
	third := YouTubeVideo{ID: "aqz-KE-bpKQ", Title: "Third"}
	nonce := "55555555-5555-4555-8555-555555555555"
	id, err := s.AddWatchQueue(room, users[0].ID, nonce, 1, first)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := s.AddWatchQueue(room, users[0].ID, nonce, 1, first)
	if err != nil || id != retry {
		t.Fatalf("retry duplicated queue: %s %s %v", id, retry, err)
	}
	if _, err = s.AddWatchQueue(room, users[0].ID, nonce, 1, second); !errors.Is(err, ErrConflict) {
		t.Fatalf("nonce changed video: %v", err)
	}
	if _, err = s.AddWatchQueue(room, users[1].ID, "66666666-6666-4666-8666-666666666666", 2, second); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AddWatchQueue(room, users[2].ID, "77777777-7777-4777-8777-777777777777", 3, third); err != nil {
		t.Fatal(err)
	}
	q, err := s.WatchQueue(room, users[0].ID)
	if err != nil || q.Viewers != 3 || len(q.Items) != 3 {
		t.Fatalf("distinct viewers or queue %+v %v", q, err)
	}
	if err = s.NextWatchVideo(room, users[0].ID, "", 0, q.Revision, false); err != nil {
		t.Fatal(err)
	}
	watch, err := s.youtubeWatch(room, users[0].ID)
	if err != nil || watch.YouTube.ID != first.ID {
		t.Fatalf("start %+v %v", watch, err)
	}
	retry, err = s.AddWatchQueue(room, users[0].ID, nonce, 1, first)
	if err != nil || retry != id {
		t.Fatalf("played receipt lost %s %v", retry, err)
	}
	q, err = s.WatchQueue(room, users[0].ID)
	if err != nil || len(q.Items) != 2 {
		t.Fatalf("played item requeued %+v %v", q, err)
	}
	if err = s.NextWatchVideo(room, users[1].ID, watch.PlaybackID, watch.Revision, 0, true); err != nil {
		t.Fatal(err)
	}
	if err = s.NextWatchVideo(room, users[1].ID, watch.PlaybackID, watch.Revision, 0, true); err != nil {
		t.Fatal(err)
	}
	unchanged, _ := s.youtubeWatch(room, users[0].ID)
	if unchanged.PlaybackID != watch.PlaybackID {
		t.Fatal("duplicate vote skipped")
	}
	// A majority vote and a host 'ended' callback racing consume only one item.
	q, _ = s.WatchQueue(room, users[0].ID)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		errs <- s.NextWatchVideo(room, users[2].ID, watch.PlaybackID, watch.Revision, 0, true)
	}()
	go func() {
		defer wg.Done()
		errs <- s.NextWatchVideo(room, users[0].ID, watch.PlaybackID, watch.Revision, q.Revision, false)
	}()
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil && !errors.Is(e, ErrConflict) {
			t.Fatal(e)
		}
	}
	next, _ := s.youtubeWatch(room, users[0].ID)
	q, _ = s.WatchQueue(room, users[0].ID)
	if next.YouTube.ID != second.ID || len(q.Items) != 1 || q.Votes != 0 {
		t.Fatalf("race double advanced %+v %+v", next, q)
	}
	if _, err = s.changeYouTubeWatch(room, users[0].ID, WatchTogetherCommand{Action: "play", PlaybackID: watch.PlaybackID, Revision: next.Revision}); !errors.Is(err, ErrConflict) {
		t.Fatalf("old playback changed replacement %v", err)
	}
	if _, err = s.DB.Exec(ctx, `UPDATE channel_watch_viewers SET seen_at=clock_timestamp()-interval '61 seconds' WHERE user_id=$1`, users[0].ID); err != nil {
		t.Fatal(err)
	}
	expired, _ := s.youtubeWatch(room, users[1].ID)
	if !expired.CanClaim {
		t.Fatal("departed host unclaimable")
	}
	if _, err = s.changeYouTubeWatch(room, users[1].ID, WatchTogetherCommand{Action: "claim", PlaybackID: expired.PlaybackID, Revision: expired.Revision}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.changeYouTubeWatch(room, users[1].ID, WatchTogetherCommand{Action: "transfer", HostID: users[0].ID, PlaybackID: expired.PlaybackID, Revision: expired.Revision + 1}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("absent target received control %v", err)
	}
}
func TestYouTubePrivatePlaylistAtomicLoadIntegration(t *testing.T) {
	s, room, users := youtubeCommunity(t)
	nonce := "11111111-1111-4111-8111-111111111111"
	video := YouTubeVideo{ID: "M7lc1UVf-VE", Title: "Video"}
	id, err := s.SaveWatchPlaylist(users[0].ID, "", nonce, "Private", []YouTubeVideo{video}, 0)
	if err != nil {
		t.Fatal(err)
	}
	lists, err := s.WatchPlaylists(users[1].ID)
	if err != nil || len(lists) != 0 {
		t.Fatalf("private list leaked %+v %v", lists, err)
	}
	if _, err = s.SaveWatchPlaylist(users[1].ID, id, "", "Steal", []YouTubeVideo{video}, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("outsider changed list %v", err)
	}
	if err = s.SetWatchViewing(room, users[0].ID, nonce, true); err != nil {
		t.Fatal(err)
	}
	if err = s.AddPlaylistWatchQueue(room, users[0].ID, id, "22222222-2222-4222-8222-222222222222", 1, 1); err != nil {
		t.Fatal(err)
	}
	if err = s.AddPlaylistWatchQueue(room, users[0].ID, id, "22222222-2222-4222-8222-222222222222", 1, 1); err != nil {
		t.Fatal(err)
	}
	q, err := s.WatchQueue(room, users[0].ID)
	if err != nil || len(q.Items) != 1 {
		t.Fatalf("playlist retry duplicated %+v %v", q, err)
	}
	tooMany := make([]YouTubeVideo, 100)
	for i := range tooMany {
		tooMany[i] = video
	}
	if _, err = s.SaveWatchPlaylist(users[0].ID, id, "", "Private", tooMany, 1); err != nil {
		t.Fatal(err)
	}
	if err = s.AddPlaylistWatchQueue(room, users[0].ID, id, "33333333-3333-4333-8333-333333333333", 2, q.Revision); !errors.Is(err, ErrWatchCapacity) {
		t.Fatalf("overflowing list accepted %v", err)
	}
	q, _ = s.WatchQueue(room, users[0].ID)
	if len(q.Items) != 1 {
		t.Fatal("overflow partially loaded")
	}
}

func TestYouTubePlayerTicketsOneUseAndRevocationIntegration(t *testing.T) {
	s, room, users := youtubeCommunity(t)
	ctx := context.Background()
	device := "11111111-1111-4111-8111-111111111111"
	if err := s.SetWatchViewing(room, users[0].ID, device, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddWatchQueue(room, users[0].ID, device, 1, YouTubeVideo{ID: "M7lc1UVf-VE", Title: "Video"}); err != nil {
		t.Fatal(err)
	}
	if err := s.NextWatchVideo(room, users[0].ID, "", 0, 2, false); err != nil {
		t.Fatal(err)
	}
	watch, err := s.youtubeWatch(room, users[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.CreateDeviceSession(ctx, sessionHash("synthetic-session-only"), users[0].ID, time.Now().Add(time.Hour), "Synthetic player test"); err != nil {
		t.Fatal(err)
	}
	a := New(s, Sessions{Store: s}, Config{AppURL: "https://app.bettrcomms.com", YouTubePlayerOrigin: "https://player.bettrcomms.com"})
	mint := func(parent string) string {
		t.Helper()
		raw, _ := json.Marshal(map[string]string{"playback_id": watch.PlaybackID, "nonce": "instance-nonce-123456", "parent_origin": parent})
		r := httptest.NewRequest("POST", "https://app.bettrcomms.com/api/v1/rooms/"+room+"/watch-together/player-ticket", strings.NewReader(string(raw)))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "bettercomms_session", Value: "synthetic-session-only"})
		w := httptest.NewRecorder()
		a.mintYouTubePlayerTicket(w, r, users[0], room)
		if w.Code != 200 {
			t.Fatalf("mint failed: %d %s", w.Code, w.Body.String())
		}
		var result map[string]string
		if json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatal("invalid minted response")
		}
		return result["ticket"]
	}
	claim := func(ticket, parent, nonce string) *httptest.ResponseRecorder {
		t.Helper()
		raw, _ := json.Marshal(map[string]string{"ticket": ticket, "nonce": nonce, "parent_origin": parent})
		r := httptest.NewRequest("POST", "https://player.bettrcomms.com/claim", strings.NewReader(string(raw)))
		r.Header.Set("Origin", "https://player.bettrcomms.com")
		r.Header.Set("Cookie", "bettercomms_session=untrusted-cookie")
		w := httptest.NewRecorder()
		a.WithYouTubePlayerHandler(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	ticket := mint("null")
	if w := claim(ticket, "null", "wrong-instance-123456"); w.Code != 403 {
		t.Fatalf("wrong nonce claimed ticket: %d", w.Code)
	}
	w := claim(ticket, "null", "instance-nonce-123456")
	if w.Code != 200 {
		t.Fatalf("authorized opaque ticket: %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), room) || strings.Contains(w.Body.String(), users[0].ID) || strings.Contains(w.Body.String(), "synthetic-session") || w.Header().Get("Set-Cookie") != "" {
		t.Fatal("player received account identifiers or cookie")
	}
	if w = claim(ticket, "null", "instance-nonce-123456"); w.Code != 403 {
		t.Fatalf("ticket replay accepted: %d", w.Code)
	}
	ticket = mint("https://app.bettrcomms.com")
	if _, err = s.DB.Exec(ctx, `UPDATE youtube_player_tickets SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if w = claim(ticket, "https://app.bettrcomms.com", "instance-nonce-123456"); w.Code != 403 {
		t.Fatal("expired ticket claimed")
	}
	ticket = mint("https://app.bettrcomms.com")
	if err = s.DeleteSession(ctx, sessionHash("synthetic-session-only")); err != nil {
		t.Fatal(err)
	}
	if w = claim(ticket, "https://app.bettrcomms.com", "instance-nonce-123456"); w.Code != 403 {
		t.Fatal("revoked session ticket claimed")
	}
}
