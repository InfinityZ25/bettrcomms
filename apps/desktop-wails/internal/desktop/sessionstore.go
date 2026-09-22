package desktop

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

var (
	// ErrNoSecret reports that nothing is stored under a name.
	ErrNoSecret = errors.New("nothing is stored under that name")
	// ErrNoCredentialStore reports a platform with no operating-system store.
	ErrNoCredentialStore = errors.New("this platform has no credential store")
)

// sessionCookieName is the only cookie worth keeping between launches. The
// OAuth state cookie lives for one redirect and would be meaningless later.
const sessionCookieName = "bettercomms_session"

// storedCookie is one persisted cookie. Only what is needed to send it again
// and to know when it has expired is kept.
type storedCookie struct {
	Name    string    `json:"name"`
	Value   string    `json:"value"`
	Path    string    `json:"path,omitempty"`
	Expires time.Time `json:"expires,omitempty"`
}

// secrets is the backing store. It is an interface so the rules above can be
// tested without writing to the person's real credential store, which a test
// run has no business leaving entries in.
type secrets interface {
	save(target string, secret []byte) error
	load(target string) ([]byte, error)
	remove(target string) error
	available() bool
}

// osSecrets is the operating system's own store.
type osSecrets struct{}

func (osSecrets) save(target string, secret []byte) error { return storeSecret(target, secret) }
func (osSecrets) load(target string) ([]byte, error)      { return loadSecret(target) }
func (osSecrets) remove(target string) error              { return deleteSecret(target) }
func (osSecrets) available() bool                         { return credentialsAvailable() }

// SessionStore keeps the API session in the operating system's credential
// store, so signing in survives closing the application.
//
// It is keyed by upstream origin: a build pointed at a different API must not
// present a session minted by another one.
type SessionStore struct {
	target  string
	secrets secrets
}

// NewSessionStore returns the store for one upstream origin.
func NewSessionStore(origin string) *SessionStore {
	return &SessionStore{target: "BetterComms/session/" + origin, secrets: osSecrets{}}
}

// Available reports whether this platform can persist a session at all.
func (s *SessionStore) Available() bool {
	return s != nil && s.secrets != nil && s.secrets.available()
}

// Save replaces what is stored with the cookies worth keeping. An empty result
// removes the entry, which is what signing out must leave behind.
func (s *SessionStore) Save(cookies []*http.Cookie) error {
	if s == nil || s.secrets == nil {
		return nil
	}

	keep := make([]storedCookie, 0, 1)
	for _, cookie := range cookies {
		if cookie.Name != sessionCookieName || cookie.Value == "" {
			continue
		}
		// A cookie the server is expiring is a sign-out, not a session.
		if cookie.MaxAge < 0 || (!cookie.Expires.IsZero() && !cookie.Expires.After(time.Now())) {
			continue
		}
		keep = append(keep, storedCookie{
			Name: cookie.Name, Value: cookie.Value,
			Path: cookie.Path, Expires: cookie.Expires,
		})
	}

	if len(keep) == 0 {
		return s.secrets.remove(s.target)
	}
	encoded, err := json.Marshal(keep)
	if err != nil {
		return fmt.Errorf("could not encode the session: %w", err)
	}
	return s.secrets.save(s.target, encoded)
}

// Load returns the stored cookies that are still valid for the given URL.
func (s *SessionStore) Load(upstream *url.URL) ([]*http.Cookie, error) {
	if s == nil || s.secrets == nil || upstream == nil {
		return nil, ErrNoSecret
	}
	encoded, err := s.secrets.load(s.target)
	if err != nil {
		return nil, err
	}

	var stored []storedCookie
	if err := json.Unmarshal(encoded, &stored); err != nil {
		// A blob this cannot read is not a session. Removing it stops the same
		// failure repeating on every launch.
		_ = s.secrets.remove(s.target)
		return nil, fmt.Errorf("the stored session was unreadable: %w", err)
	}

	now := time.Now()
	cookies := make([]*http.Cookie, 0, len(stored))
	for _, entry := range stored {
		if entry.Name == "" || entry.Value == "" {
			continue
		}
		if !entry.Expires.IsZero() && !entry.Expires.After(now) {
			continue
		}
		path := entry.Path
		if path == "" {
			path = "/"
		}
		cookies = append(cookies, &http.Cookie{
			Name: entry.Name, Value: entry.Value, Path: path, Expires: entry.Expires,
		})
	}
	if len(cookies) == 0 {
		// Everything in there has expired; do not keep asking for it.
		_ = s.secrets.remove(s.target)
		return nil, ErrNoSecret
	}
	return cookies, nil
}

// Clear removes the stored session.
func (s *SessionStore) Clear() error {
	if s == nil {
		return nil
	}
	return s.secrets.remove(s.target)
}
