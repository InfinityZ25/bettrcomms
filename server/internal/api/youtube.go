package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var youtubeIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
var ErrWatchCapacity = errors.New("watch capacity reached")

type YouTubeVideo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

func canonicalYouTubeID(raw string) (string, error) {
	if len(raw) > 2048 {
		return "", ErrForbidden
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return "", ErrForbidden
	}
	var id string
	switch strings.ToLower(u.Hostname()) {
	case "youtu.be":
		if strings.Count(u.Path, "/") != 1 {
			return "", ErrForbidden
		}
		id = strings.TrimPrefix(u.Path, "/")
	case "youtube.com", "www.youtube.com", "m.youtube.com":
		if u.Path == "/watch" {
			id = u.Query().Get("v")
		} else if strings.HasPrefix(u.Path, "/shorts/") && strings.Count(u.Path, "/") == 2 {
			id = strings.TrimPrefix(u.Path, "/shorts/")
		}
	default:
		return "", ErrForbidden
	}
	if !youtubeIDPattern.MatchString(id) {
		return "", ErrForbidden
	}
	return id, nil
}
func (a *API) youtubeVideo(ctx context.Context, raw, title string) (YouTubeVideo, error) {
	id, err := canonicalYouTubeID(raw)
	if err != nil {
		return YouTubeVideo{}, err
	}
	fallback := "YouTube · " + id
	if activityText(strings.TrimSpace(title), 1, 200) {
		fallback = strings.TrimSpace(title)
	}
	video := YouTubeVideo{ID: id, Title: fallback}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.youtube.com/oembed?format=json&url="+url.QueryEscape("https://www.youtube.com/watch?v="+id), nil)
	if err != nil {
		return video, nil
	}
	client := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if a.HTTP != nil {
		client.Transport = a.HTTP.Transport
	}
	response, err := client.Do(request)
	if err != nil {
		return video, nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return video, nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 32769))
	if err != nil || len(data) > 32768 {
		return video, nil
	}
	var metadata struct {
		Title string `json:"title"`
	}
	if json.Unmarshal(data, &metadata) == nil && title == "" && activityText(strings.TrimSpace(metadata.Title), 1, 200) {
		video.Title = strings.TrimSpace(metadata.Title)
	}
	return video, nil
}
func (a *API) YouTubeConfig() map[string]any {
	return map[string]any{"youtube_enabled": a.Config.YouTubePlayerOrigin != "", "player_origin": a.Config.YouTubePlayerOrigin, "watch_sources": []string{"file", "youtube"}}
}
func validYouTubeVideo(v YouTubeVideo) bool {
	return youtubeIDPattern.MatchString(v.ID) && activityText(v.Title, 1, 200)
}
func ValidateYouTubePlayerOrigin(raw, app string) error {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	a, _ := url.Parse(app)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")) || a != nil && u.Scheme == a.Scheme && u.Host == a.Host {
		return fmt.Errorf("YOUTUBE_PLAYER_ORIGIN must be a distinct HTTPS origin (HTTP loopback only for development)")
	}
	return nil
}
