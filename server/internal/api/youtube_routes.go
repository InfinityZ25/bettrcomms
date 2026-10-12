package api

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (a *API) routeYouTubeFeatures(w http.ResponseWriter, r *http.Request, p []string, u User) bool {
	playlists := len(p) >= 2 && p[0] == "me" && p[1] == "watch-playlists"
	watch := len(p) >= 4 && p[0] == "rooms" && p[2] == "watch-together"
	if !playlists && !watch {
		return false
	}
	s, ok := a.Store.(*PostgresStore)
	if !ok {
		a.fail(w, 503, "unavailable", "Watch Together is unavailable")
		return true
	}
	if r.Method != http.MethodGet && !a.limiter.allow("youtube-action:"+u.ID, 180, time.Minute) {
		a.fail(w, 429, "rate_limited", "Too many Watch Together actions")
		return true
	}
	result := func(data any, err error) {
		if errors.Is(err, ErrWatchCapacity) {
			a.fail(w, 409, "watch_limit", "The maximum is 100 queue videos or playlists")
		} else {
			a.result(w, data, err)
		}
	}
	if playlists {
		if len(p) == 2 && r.Method == http.MethodGet {
			v, e := s.WatchPlaylists(u.ID)
			result(map[string]any{"playlists": v}, e)
			return true
		}
		var in struct {
			Name    string         `json:"name"`
			Videos  []YouTubeVideo `json:"videos"`
			Version int64          `json:"version"`
			Nonce   string         `json:"client_nonce"`
		}
		if !a.decode(w, r, &in) {
			return true
		}
		id := ""
		if len(p) == 3 && uuidPattern.MatchString(p[2]) {
			id = p[2]
		} else if len(p) != 2 {
			a.fail(w, 404, "not_found", "Playlist not found")
			return true
		}
		if r.Method == http.MethodDelete && id != "" {
			result(map[string]bool{"ok": true}, s.DeleteWatchPlaylist(u.ID, id, in.Version))
			return true
		}
		if r.Method != http.MethodPost && r.Method != http.MethodPut {
			a.fail(w, 405, "method_not_allowed", "Method not allowed")
			return true
		}
		in.Name = strings.TrimSpace(in.Name)
		if id == "" && !uuidPattern.MatchString(in.Nonce) || !activityText(in.Name, 1, 100) || len(in.Videos) > 100 {
			a.fail(w, 400, "invalid_playlist", "Choose a name and up to 100 videos")
			return true
		}
		for _, video := range in.Videos {
			if !validYouTubeVideo(video) {
				a.fail(w, 400, "invalid_playlist", "Playlist videos must be YouTube IDs and titles")
				return true
			}
		}
		id, e := s.SaveWatchPlaylist(u.ID, id, in.Nonce, in.Name, in.Videos, in.Version)
		if e == nil {
			a.Realtime.publishUser(u.ID, wire{Type: "watch.playlists"})
		}
		result(map[string]string{"id": id}, e)
		return true
	}
	room := strings.ToLower(p[1])
	if !uuidPattern.MatchString(room) {
		a.fail(w, 404, "not_found", "Channel not found")
		return true
	}
	if _, e := s.RoomForMember(room, u.ID); e != nil {
		result(nil, e)
		return true
	}
	if e := s.RoomPermission(room, u.ID, "join_voice"); e != nil {
		result(nil, e)
		return true
	}
	if p[3] == "player-ticket" && len(p) == 4 && r.Method == http.MethodPost {
		a.mintYouTubePlayerTicket(w, r, u, room)
		return true
	}
	if p[3] == "queue" && len(p) == 4 && r.Method == http.MethodGet {
		v, e := s.WatchQueue(room, u.ID)
		result(v, e)
		return true
	}
	var err error
	switch p[3] {
	case "viewing":
		var in struct {
			DeviceID string `json:"device_id"`
			Present  bool   `json:"present"`
		}
		if !a.decode(w, r, &in) {
			return true
		}
		if r.Method != http.MethodPut || !uuidPattern.MatchString(in.DeviceID) {
			a.fail(w, 400, "invalid_viewer", "Choose a valid viewing device")
			return true
		}
		err = s.SetWatchViewing(room, u.ID, in.DeviceID, in.Present)
	case "queue":
		if a.Config.YouTubePlayerOrigin == "" {
			a.fail(w, 503, "youtube_unavailable", "YouTube playback is not configured")
			return true
		}
		if len(p) == 4 && r.Method == http.MethodPost {
			var in struct {
				URL      string `json:"video_url"`
				Title    string `json:"title"`
				Nonce    string `json:"client_nonce"`
				Revision int64  `json:"revision"`
			}
			if !a.decode(w, r, &in) {
				return true
			}
			if !uuidPattern.MatchString(in.Nonce) || in.Revision < 1 {
				a.fail(w, 400, "invalid_queue", "Choose a YouTube URL and current queue revision")
				return true
			}
			if !a.limiter.allow("youtube-metadata:"+u.ID, 30, time.Minute) {
				a.fail(w, 429, "rate_limited", "Too many YouTube links")
				return true
			}
			video, e := a.youtubeVideo(r.Context(), in.URL, in.Title)
			if e != nil {
				a.fail(w, 400, "invalid_youtube", "Use a YouTube video or Shorts HTTPS link")
				return true
			}
			_, err = s.AddWatchQueue(room, u.ID, in.Nonce, in.Revision, video)
		} else if len(p) == 5 && p[4] == "playlist" && r.Method == http.MethodPost {
			var in struct {
				PlaylistID string `json:"playlist_id"`
				Version    int64  `json:"playlist_version"`
				Nonce      string `json:"client_nonce"`
				Revision   int64  `json:"revision"`
			}
			if !a.decode(w, r, &in) {
				return true
			}
			if !uuidPattern.MatchString(in.PlaylistID) || !uuidPattern.MatchString(in.Nonce) || in.Version < 1 || in.Revision < 1 {
				a.fail(w, 400, "invalid_playlist", "Choose a current saved playlist")
				return true
			}
			err = s.AddPlaylistWatchQueue(room, u.ID, in.PlaylistID, in.Nonce, in.Version, in.Revision)
		} else if len(p) == 5 && p[4] == "order" && r.Method == http.MethodPut {
			var in struct {
				IDs      []string `json:"ids"`
				Revision int64    `json:"revision"`
			}
			if !a.decode(w, r, &in) {
				return true
			}
			if len(in.IDs) > 100 {
				a.fail(w, 400, "invalid_queue", "Queue can contain up to 100 videos")
				return true
			}
			err = s.ReorderWatchQueue(room, u.ID, in.IDs, in.Revision)
		} else if len(p) == 5 && uuidPattern.MatchString(p[4]) && r.Method == http.MethodDelete {
			var in struct {
				Revision int64 `json:"revision"`
			}
			if !a.decode(w, r, &in) {
				return true
			}
			err = s.RemoveWatchQueue(room, u.ID, p[4], in.Revision)
		} else {
			a.fail(w, 405, "method_not_allowed", "Method not allowed")
			return true
		}
	case "next", "skip-vote":
		var in struct {
			Playback      string `json:"playback_id"`
			Revision      int64  `json:"revision"`
			QueueRevision int64  `json:"queue_revision"`
		}
		if !a.decode(w, r, &in) {
			return true
		}
		if r.Method != http.MethodPost || in.Revision < 0 || in.Playback != "" && !uuidPattern.MatchString(in.Playback) {
			a.fail(w, 400, "invalid_watch", "Refresh playback before changing the video")
			return true
		}
		err = s.NextWatchVideo(room, u.ID, in.Playback, in.Revision, in.QueueRevision, p[3] == "skip-vote")
	default:
		a.fail(w, 404, "not_found", "Watch Together action not found")
		return true
	}
	if err == nil {
		a.publishChannelActivity(room, "watch-together")
	}
	result(map[string]bool{"ok": true}, err)
	return true
}
