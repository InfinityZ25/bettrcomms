//go:build windows

package desktop

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"
)

// The acceptance test for the credential store: the real Windows Credential
// Manager, on this machine, through the real CredWriteW/CredReadW/CredDeleteW.
//
// Every entry it makes is removed again, including when an assertion fails, so
// running the suite leaves nothing behind in the person's credential manager.
func testTarget(t *testing.T) string {
	t.Helper()
	target := fmt.Sprintf("BetterComms/test/%d/%d", os.Getpid(), time.Now().UnixNano())
	t.Cleanup(func() {
		if err := deleteSecret(target); err != nil {
			t.Errorf("the test entry was left behind: %v", err)
		}
	})
	return target
}

func TestTheRealCredentialManagerStoresAndReturnsASecret(t *testing.T) {
	target := testTarget(t)

	if _, err := loadSecret(target); !errors.Is(err, ErrNoSecret) {
		t.Fatalf("an unused name returned %v, want ErrNoSecret", err)
	}

	secret := []byte(`{"name":"bettercomms_session","value":"a-real-looking-session-value"}`)
	if err := storeSecret(target, secret); err != nil {
		t.Fatalf("storeSecret: %v", err)
	}

	restored, err := loadSecret(target)
	if err != nil {
		t.Fatalf("loadSecret: %v", err)
	}
	if string(restored) != string(secret) {
		t.Fatalf("restored %q, want %q", restored, secret)
	}
	t.Logf("Windows Credential Manager returned %d bytes unchanged", len(restored))

	// Writing again must replace rather than fail or duplicate.
	replacement := []byte("second")
	if err := storeSecret(target, replacement); err != nil {
		t.Fatalf("second storeSecret: %v", err)
	}
	if restored, err = loadSecret(target); err != nil || string(restored) != "second" {
		t.Fatalf("after replacing: %q %v", restored, err)
	}

	if err := deleteSecret(target); err != nil {
		t.Fatalf("deleteSecret: %v", err)
	}
	if _, err := loadSecret(target); !errors.Is(err, ErrNoSecret) {
		t.Errorf("the secret survived deletion: %v", err)
	}
	// Deleting what is not there is the caller's intent already satisfied.
	if err := deleteSecret(target); err != nil {
		t.Errorf("deleting an absent secret failed: %v", err)
	}
}

// An empty secret means "store nothing", which must leave no entry rather than
// an entry holding nothing.
func TestStoringAnEmptySecretRemovesTheEntry(t *testing.T) {
	target := testTarget(t)

	if err := storeSecret(target, []byte("something")); err != nil {
		t.Fatalf("storeSecret: %v", err)
	}
	if err := storeSecret(target, nil); err != nil {
		t.Fatalf("storeSecret(nil): %v", err)
	}
	if _, err := loadSecret(target); !errors.Is(err, ErrNoSecret) {
		t.Errorf("an entry survived being emptied: %v", err)
	}
}

// Credential Manager bounds a blob. Failing here names the reason, rather than
// letting Windows refuse with an error code that explains nothing.
func TestAnOversizedSecretIsRefusedWithAReason(t *testing.T) {
	target := testTarget(t)

	if err := storeSecret(target, make([]byte, maxBlob+1)); err == nil {
		t.Error("an oversized secret was accepted")
	}
}

// The whole point, end to end on the real store: a session saved by one launch
// is returned to the next.
func TestASessionSurvivesThroughTheRealCredentialManager(t *testing.T) {
	target := testTarget(t)
	upstream, err := url.Parse("https://api.example.test")
	if err != nil {
		t.Fatal(err)
	}

	// Two stores over the same entry are two launches of the application.
	first := &SessionStore{target: target, secrets: osSecrets{}}
	second := &SessionStore{target: target, secrets: osSecrets{}}

	if !first.Available() {
		t.Fatal("Windows reported no credential store")
	}

	expires := time.Now().Add(14 * 24 * time.Hour)
	if err := first.Save([]*http.Cookie{
		{Name: sessionCookieName, Value: "session-value", Path: "/", Expires: expires},
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	restored, err := second.Load(upstream)
	if err != nil {
		t.Fatalf("the next launch could not load the session: %v", err)
	}
	if len(restored) != 1 || restored[0].Value != "session-value" {
		t.Fatalf("restored %#v", restored)
	}
	t.Log("a session written by one launch was read back by another")

	// Signing out has to erase it.
	if err := second.Save(nil); err != nil {
		t.Fatalf("Save(nil): %v", err)
	}
	if _, err := first.Load(upstream); !errors.Is(err, ErrNoSecret) {
		t.Errorf("the session survived signing out: %v", err)
	}
}
