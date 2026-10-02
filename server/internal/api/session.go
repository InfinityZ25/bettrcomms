package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strings"
	"time"
)

type SessionStore interface {
	CreateSession(context.Context, []byte, string, time.Time) error
	SessionUser(context.Context, []byte, time.Time) (string, error)
	DeleteSession(context.Context, []byte) error
	DeleteExpiredSessions(context.Context, time.Time) error
}
type Sessions struct {
	Store  SessionStore
	Secure bool
}

func sessionHash(token string) []byte { sum := sha256.Sum256([]byte(token)); return sum[:] }
func (s Sessions) Set(r *http.Request, w http.ResponseWriter, userID string) error {
	token, e := randomToken()
	if e != nil {
		return e
	}
	expires := time.Now().Add(14 * 24 * time.Hour)
	if managed, ok := s.Store.(ManagedSessions); ok {
		e = managed.CreateDeviceSession(r.Context(), sessionHash(token), userID, expires, deviceName(r.UserAgent()))
	} else {
		e = s.Store.CreateSession(r.Context(), sessionHash(token), userID, expires)
	}
	if e != nil {
		return e
	}
	_ = s.Store.DeleteExpiredSessions(r.Context(), time.Now())
	http.SetCookie(w, &http.Cookie{Name: "bettercomms_session", Value: token, Path: "/", Expires: expires, MaxAge: 14 * 86400, HttpOnly: true, Secure: s.Secure, SameSite: http.SameSiteLaxMode})
	return nil
}
func (s Sessions) Clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: "bettercomms_session", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.Secure, SameSite: http.SameSiteLaxMode})
}
func (s Sessions) UserID(r *http.Request) (string, error) {
	if _, ok := s.Store.(ManagedSessions); ok {
		item, err := s.Resolve(r)
		return item.UserID, err
	}
	c, e := r.Cookie("bettercomms_session")
	if e != nil {
		return "", e
	}
	return s.Store.SessionUser(r.Context(), sessionHash(c.Value), time.Now())
}
func (s Sessions) Resolve(r *http.Request) (DeviceSession, error) {
	c, err := r.Cookie("bettercomms_session")
	if err != nil {
		return DeviceSession{}, err
	}
	if managed, ok := s.Store.(ManagedSessions); ok {
		return managed.ResolveSession(r.Context(), sessionHash(c.Value), time.Now())
	}
	user, err := s.Store.SessionUser(r.Context(), sessionHash(c.Value), time.Now())
	return DeviceSession{UserID: user}, err
}
func deviceName(agent string) string {
	os := "Other system"
	browser := "Browser"
	switch {
	case strings.Contains(agent, "Windows"):
		os = "Windows"
	case strings.Contains(agent, "iPhone") || strings.Contains(agent, "iPad"):
		os = "iOS"
	case strings.Contains(agent, "Android"):
		os = "Android"
	case strings.Contains(agent, "Macintosh"):
		os = "macOS"
	case strings.Contains(agent, "Linux"):
		os = "Linux"
	}
	switch {
	case strings.Contains(agent, "BetterComms Desktop"):
		browser = "BetterComms Desktop"
	case strings.Contains(agent, "Edg/"):
		browser = "Edge"
	case strings.Contains(agent, "Firefox/"):
		browser = "Firefox"
	case strings.Contains(agent, "Chrome/"):
		browser = "Chrome"
	case strings.Contains(agent, "Safari/"):
		browser = "Safari"
	}
	return os + " · " + browser
}
func (s Sessions) Revoke(r *http.Request) error {
	c, e := r.Cookie("bettercomms_session")
	if e != nil {
		return nil
	}
	return s.Store.DeleteSession(r.Context(), sessionHash(c.Value))
}
func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
