package desktop

import (
	"errors"
	"os"
	"strings"
	"testing"
)

// TestReleaseOriginMatchesTheTauriHost keeps both desktop shells pinned to the
// same production origin. Two hosts trusting different origins is exactly the
// kind of drift a reader would assume cannot happen.
func TestReleaseOriginMatchesTheTauriHost(t *testing.T) {
	const rust = "../../../desktop/src-tauri/src/media_permissions.rs"
	source, err := os.ReadFile(rust)
	if err != nil {
		t.Skipf("the Tauri host is not in this checkout: %v", err)
	}
	want := `pub(crate) const RELEASE_ORIGIN: &str = "` + ReleaseOrigin + `";`
	if !strings.Contains(string(source), want) {
		t.Errorf("%s does not contain %s", rust, want)
	}
}

func TestResolveAPIOriginAcceptsHTTPS(t *testing.T) {
	for _, raw := range []string{
		ReleaseOrigin,
		ReleaseOrigin + "/",
		"HTTPS://BettrComms-Production.Up.Railway.App",
		"https://api.example.test:8443",
	} {
		if _, err := ResolveAPIOrigin(raw, false); err != nil {
			t.Errorf("ResolveAPIOrigin(%q) = %v, want accepted", raw, err)
		}
	}
}

func TestResolveAPIOriginCanonicalises(t *testing.T) {
	got, err := ResolveAPIOrigin("HTTPS://Example.Test:8443/", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if want := "https://example.test:8443"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestResolveAPIOriginRejectsUnsafeValues(t *testing.T) {
	// Each of these would change where session material is sent, so none may be
	// silently normalised into something acceptable.
	for _, raw := range []string{
		"",
		"   ",
		"not a url",
		"example.test",
		"ftp://example.test",
		"http://bettrcomms-production.up.railway.app",
		"https://user:secret@example.test",
		"https://example.test/api",
		"https://example.test/?token=abc",
		"https://example.test/#/settings",
		"https://",
	} {
		if got, err := ResolveAPIOrigin(raw, false); err == nil {
			t.Errorf("ResolveAPIOrigin(%q) = %q, want rejected", raw, got)
		}
	}
}

func TestResolveAPIOriginAllowsLoopbackHTTPOnlyInDebug(t *testing.T) {
	const loopback = "http://127.0.0.1:8080"
	if _, err := ResolveAPIOrigin(loopback, false); err == nil {
		t.Error("plaintext loopback must be rejected when loopback HTTP is not allowed")
	}
	if _, err := ResolveAPIOrigin(loopback, true); err != nil {
		t.Errorf("debug loopback rejected: %v", err)
	}
	for _, raw := range []string{"http://localhost:5173", "http://[::1]:8080"} {
		if _, err := ResolveAPIOrigin(raw, true); err != nil {
			t.Errorf("ResolveAPIOrigin(%q, debug) = %v, want accepted", raw, err)
		}
	}
	// Debug relaxation is for loopback only; it is not a general HTTP opt-in.
	if _, err := ResolveAPIOrigin("http://example.test", true); err == nil {
		t.Error("debug builds must not accept plaintext for a remote host")
	}
}

func TestResolveAPIOriginReportsMissingValue(t *testing.T) {
	if _, err := ResolveAPIOrigin("", true); !errors.Is(err, ErrMissingAPIOrigin) {
		t.Errorf("got %v, want ErrMissingAPIOrigin", err)
	}
}
