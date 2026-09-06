package api

import (
	"net"
	"net/http"
	"sync"
	"time"
)

type rateEntry struct {
	start time.Time
	count int
}
type rateLimiter struct {
	mu      sync.Mutex
	entries map[string]rateEntry
}

func newRateLimiter() *rateLimiter { return &rateLimiter{entries: map[string]rateEntry{}} }
func (l *rateLimiter) allow(key string, limit int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	e := l.entries[key]
	if e.start.IsZero() || now.Sub(e.start) >= window {
		e = rateEntry{start: now}
	}
	e.count++
	l.entries[key] = e
	return e.count <= limit
}
func remoteIP(r *http.Request) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e == nil {
		return host
	}
	return r.RemoteAddr
}
func (a *API) rate(scope string, limit int, window time.Duration, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.limiter.allow(scope+":"+remoteIP(r), limit, window) {
			w.Header().Set("Retry-After", "60")
			a.fail(w, 429, "rate_limited", "too many requests")
			return
		}
		next.ServeHTTP(w, r)
	})
}
