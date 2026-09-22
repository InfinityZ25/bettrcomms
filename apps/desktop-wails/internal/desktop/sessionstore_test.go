package desktop

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// memorySecrets stands in for the operating system's store, so these rules are
// tested without leaving entries in the person's real credential manager.
type memorySecrets struct {
	entries   map[string][]byte
	offline   bool
	saveError error
}

func newMemorySecrets() *memorySecrets { return &memorySecrets{entries: map[string][]byte{}} }

func (m *memorySecrets) save(target string, secret []byte) error {
	if m.saveError != nil {
		return m.saveError
	}
	m.entries[target] = append([]byte(nil), secret...)
	return nil
}

func (m *memorySecrets) load(target string) ([]byte, error) {
	secret, ok := m.entries[target]
	if !ok {
		return nil, ErrNoSecret
	}
	return append([]byte(nil), secret...), nil
}

func (m *memorySecrets) remove(target string) error {
	delete(m.entries, target)
	return nil
}

func (m *memorySecrets) available() bool { return !m.offline }

func testSessionStore(t *testing.T) (*SessionStore, *memorySecrets) {
	t.Helper()
	backing := newMemorySecrets()
	return &SessionStore{target: "test/session", secrets: backing}, backing
}

func upstreamURL(t *testing.T) *url.URL {
	t.Helper()
	parsed, err := url.Parse("https://api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func session(value string, expires time.Time) *http.Cookie {
	return &http.Cookie{Name: sessionCookieName, Value: value, Path: "/", Expires: expires}
}

// The point of the store: a session obtained in one launch is there in the
// next, so nobody signs in again every time they open the application.
func TestASavedSessionComesBackOnTheNextLaunch(t *testing.T) {
	store, _ := testSessionStore(t)
	upstream := upstreamURL(t)

	if _, err := store.Load(upstream); !errors.Is(err, ErrNoSecret) {
		t.Fatalf("a fresh store returned %v, want ErrNoSecret", err)
	}

	if err := store.Save([]*http.Cookie{session("s3cret", time.Now().Add(14*24*time.Hour))}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	restored, err := store.Load(upstream)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(restored) != 1 || restored[0].Name != sessionCookieName || restored[0].Value != "s3cret" {
		t.Fatalf("restored %#v", restored)
	}
	if restored[0].Path != "/" {
		t.Errorf("path = %q", restored[0].Path)
	}
}

// Only the session is worth keeping. The OAuth state cookie lives for one
// redirect, and storing it would leave a secret behind for nothing.
func TestOnlyTheSessionCookieIsKept(t *testing.T) {
	store, backing := testSessionStore(t)

	err := store.Save([]*http.Cookie{
		{Name: "bettercomms_oauth_state", Value: "transient", Path: "/api/v1/auth/callback"},
		session("s3cret", time.Now().Add(time.Hour)),
		{Name: "analytics", Value: "nope"},
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	stored := string(backing.entries["test/session"])
	if stored == "" {
		t.Fatal("nothing was stored")
	}
	for _, unwanted := range []string{"oauth_state", "transient", "analytics", "nope"} {
		if strings.Contains(stored, unwanted) {
			t.Errorf("the stored blob contains %q", unwanted)
		}
	}
}

// Signing out arrives as a Set-Cookie that expires the session. It has to erase
// the stored copy, or the next launch would sign the person back in.
func TestSigningOutRemovesTheStoredSession(t *testing.T) {
	store, backing := testSessionStore(t)
	upstream := upstreamURL(t)

	if err := store.Save([]*http.Cookie{session("s3cret", time.Now().Add(time.Hour))}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(backing.entries) != 1 {
		t.Fatal("the session was not stored")
	}

	// This is what the jar holds after a logout: nothing.
	if err := store.Save(nil); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(backing.entries) != 0 {
		t.Error("the stored session survived signing out")
	}
	if _, err := store.Load(upstream); !errors.Is(err, ErrNoSecret) {
		t.Errorf("Load returned %v after signing out", err)
	}
}

// A cookie the server is actively expiring is a sign-out, not a session.
func TestAnExpiringCookieIsNotStoredAsASession(t *testing.T) {
	store, backing := testSessionStore(t)

	for _, cookie := range []*http.Cookie{
		{Name: sessionCookieName, Value: "gone", Path: "/", MaxAge: -1},
		session("stale", time.Now().Add(-time.Hour)),
		{Name: sessionCookieName, Value: "", Path: "/"},
	} {
		if err := store.Save([]*http.Cookie{cookie}); err != nil {
			t.Fatalf("Save: %v", err)
		}
		if len(backing.entries) != 0 {
			t.Errorf("%#v was stored as a session", cookie)
			backing.entries = map[string][]byte{}
		}
	}
}

// A session that has run out must not be offered to the API, and must not sit
// in the credential store being re-read on every launch.
func TestAnExpiredStoredSessionIsDiscarded(t *testing.T) {
	store, backing := testSessionStore(t)
	upstream := upstreamURL(t)

	// Written while valid, read back after it has run out.
	if err := store.Save([]*http.Cookie{session("s3cret", time.Now().Add(50*time.Millisecond))}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	time.Sleep(80 * time.Millisecond)

	if _, err := store.Load(upstream); !errors.Is(err, ErrNoSecret) {
		t.Errorf("Load returned %v for an expired session", err)
	}
	if len(backing.entries) != 0 {
		t.Error("the expired session was left in the store")
	}
}

// A blob that cannot be read is not a session, and leaving it there would
// repeat the same failure on every launch.
func TestAnUnreadableBlobIsCleared(t *testing.T) {
	store, backing := testSessionStore(t)
	backing.entries["test/session"] = []byte("not json")

	if _, err := store.Load(upstreamURL(t)); err == nil {
		t.Error("an unreadable blob was accepted")
	}
	if len(backing.entries) != 0 {
		t.Error("the unreadable blob was left in the store")
	}
}

// Each upstream gets its own entry: a build pointed at another API must not
// present a session minted somewhere else.
func TestTheStoreIsKeyedByUpstreamOrigin(t *testing.T) {
	first := NewSessionStore("https://api.example.test")
	second := NewSessionStore("https://staging.example.test")

	if first.target == second.target {
		t.Errorf("two origins share the entry %q", first.target)
	}
	for _, store := range []*SessionStore{first, second} {
		if !strings.Contains(store.target, "BetterComms") {
			t.Errorf("the entry %q is not namespaced to this application", store.target)
		}
	}
}

// A host with no credential store must not pretend. Nothing is persisted, and
// a nil store is safe to call.
func TestAHostWithoutAStoreIsSafe(t *testing.T) {
	var absent *SessionStore
	if absent.Available() {
		t.Error("a nil store reported itself available")
	}
	if err := absent.Save([]*http.Cookie{session("s", time.Now().Add(time.Hour))}); err != nil {
		t.Errorf("Save on a nil store: %v", err)
	}
	if _, err := absent.Load(upstreamURL(t)); !errors.Is(err, ErrNoSecret) {
		t.Errorf("Load on a nil store returned %v", err)
	}
	if err := absent.Clear(); err != nil {
		t.Errorf("Clear on a nil store: %v", err)
	}

	store, backing := testSessionStore(t)
	backing.offline = true
	if store.Available() {
		t.Error("a store with no backing reported itself available")
	}
}
