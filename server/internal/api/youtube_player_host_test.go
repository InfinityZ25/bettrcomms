package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestYouTubeDisabledProductionHostNeverReachesApplication(t *testing.T) {
	for _, origin := range []string{"", "https://player.other.test", "http://127.0.0.1:5176", "https://user@player.bettrcomms.com"} {
		t.Run(origin, func(t *testing.T) {
			a := New(nil, Sessions{}, Config{AppURL: "https://app.bettrcomms.com", YouTubePlayerOrigin: origin})
			calls := 0
			handler := a.WithYouTubePlayerHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(http.StatusNoContent)
			}))
			for _, authority := range []string{"player.bettrcomms.com", "PLAYER.BETTRCOMMS.COM", "player.bettrcomms.com:443", "player.bettrcomms.com:80", "player.bettrcomms.com:8080"} {
				for _, path := range []string{"/", "/api/v1/me", "/api/v1/auth/native", "/auth", "/ws", "/player", "/player.js", "/player?opaque=1", "/claim"} {
					request := httptest.NewRequest(http.MethodGet, "https://app.bettrcomms.com"+path, nil)
					request.Host = authority
					request.Header.Set("Cookie", "bettercomms_session=synthetic-must-not-resolve")
					if path == "/claim" {
						request.Method = http.MethodPost
					}
					if path == "/ws" {
						request.Header.Set("Connection", "Upgrade")
						request.Header.Set("Upgrade", "websocket")
					}
					response := httptest.NewRecorder()
					handler.ServeHTTP(response, request)
					if response.Code != http.StatusNotFound || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Set-Cookie") != "" || calls != 0 {
						t.Fatalf("disabled helper authority=%s path=%s status=%d application calls=%d", authority, path, response.Code, calls)
					}
				}
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodGet, "https://app.bettrcomms.com/healthz", nil)
				request.Host = authority
				request.Header.Set("Cookie", "bettercomms_session=synthetic-must-not-resolve")
				handler.ServeHTTP(response, request)
				var status struct {
					Status string `json:"status"`
				}
				if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &status) != nil || status.Status != "disabled" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Set-Cookie") != "" || calls != 0 {
					t.Fatalf("disabled health authority=%s status=%d application calls=%d", authority, response.Code, calls)
				}
			}
			for _, authority := range []string{"app.bettrcomms.com", "player.bettrcomms.com.evil.test", "other.test"} {
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodGet, "https://app.bettrcomms.com/api/v1/me", nil)
				request.Host = authority
				handler.ServeHTTP(response, request)
				if response.Code != http.StatusNoContent {
					t.Fatalf("ordinary authority=%s status=%d", authority, response.Code)
				}
			}
			if calls != 3 {
				t.Fatalf("application calls=%d", calls)
			}
		})
	}
}

func TestYouTubeConfiguredProductionAuthorityAliasesRemainIsolated(t *testing.T) {
	for _, origin := range []string{"https://player.bettrcomms.com", "https://PLAYER.BETTRCOMMS.COM:443"} {
		t.Run(origin, func(t *testing.T) {
			a := New(nil, Sessions{}, Config{AppURL: "https://app.bettrcomms.com", YouTubePlayerOrigin: origin})
			calls := 0
			handler := a.WithYouTubePlayerHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(http.StatusNoContent)
			}))
			for _, authority := range []string{"player.bettrcomms.com", "PLAYER.BETTRCOMMS.COM", "player.bettrcomms.com:443"} {
				for _, path := range []string{"/player", "/player.js", "/healthz", "/player?opaque=1", "/api/v1/me", "/api/v1/auth/native", "/auth", "/ws"} {
					request := httptest.NewRequest(http.MethodGet, "https://app.bettrcomms.com"+path, nil)
					request.Host = authority
					request.Header.Set("Cookie", "bettercomms_session=synthetic-must-not-resolve")
					response := httptest.NewRecorder()
					handler.ServeHTTP(response, request)
					want := http.StatusNotFound
					if path == "/player" || path == "/player.js" || path == "/healthz" || path == "/player?opaque=1" {
						want = http.StatusOK
					}
					if response.Code != want || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Set-Cookie") != "" || calls != 0 {
						t.Fatalf("configured helper authority=%s path=%s status=%d want=%d application calls=%d", authority, path, response.Code, want, calls)
					}
				}
			}
			for _, authority := range []string{"player.bettrcomms.com:80", "player.bettrcomms.com:8443"} {
				request := httptest.NewRequest(http.MethodGet, "https://app.bettrcomms.com/player", nil)
				request.Host = authority
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if response.Code != http.StatusNotFound || calls != 0 {
					t.Fatalf("nonconfigured production authority=%s status=%d application calls=%d", authority, response.Code, calls)
				}
			}
		})
	}
}

func TestYouTubeDevelopmentHelperUsesExactConfiguredAuthority(t *testing.T) {
	a := New(nil, Sessions{}, Config{AppURL: "http://localhost:5173", YouTubePlayerOrigin: "http://localhost:5176"})
	calls := 0
	handler := a.WithYouTubePlayerHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, authority := range []string{"localhost:5176", "LOCALHOST:5176"} {
		request := httptest.NewRequest(http.MethodGet, "http://localhost:5173/player", nil)
		request.Host = authority
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK || calls != 0 {
			t.Fatalf("configured development authority=%s status=%d application calls=%d", authority, response.Code, calls)
		}
	}
	for _, authority := range []string{"localhost", "localhost:80", "localhost:5173", "127.0.0.1:5176", "app.bettrcomms.com"} {
		request := httptest.NewRequest(http.MethodGet, "http://localhost:5173/player", nil)
		request.Host = authority
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("ordinary development authority=%s status=%d", authority, response.Code)
		}
	}
	if calls != 5 {
		t.Fatalf("application calls=%d", calls)
	}
}

func TestYouTubeHelperRejectsMalformedAuthoritiesBeforeApplication(t *testing.T) {
	a := New(nil, Sessions{}, Config{AppURL: "https://app.bettrcomms.com"})
	calls := 0
	handler := a.WithYouTubePlayerHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, authority := range []string{"", " player.bettrcomms.com", "player.bettrcomms.com.", "player.bettrcomms.com:", "player.bettrcomms.com:bad", "player.bettrcomms.com:0443", "player.bettrcomms.com:65536", "player.bettrcomms.com:0", "user@player.bettrcomms.com", "player.bettrcomms.com/path", "player.bettrcomms.com?other", "player.bettrcomms.com#other", "player.bettrcomms.com\\other", "[player.bettrcomms.com]", "[127.0.0.1]:443"} {
		request := httptest.NewRequest(http.MethodGet, "https://app.bettrcomms.com/api/v1/me", nil)
		request.Host = authority
		request.Header.Set("Cookie", "bettercomms_session=synthetic-must-not-resolve")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Set-Cookie") != "" || calls != 0 {
			t.Fatalf("malformed authority=%q status=%d application calls=%d", authority, response.Code, calls)
		}
	}
}
