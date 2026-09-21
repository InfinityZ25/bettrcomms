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
		"http://app.bettrcomms.com",
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

// The trusted set is what stops a webview that has navigated to an identity
// provider from reaching a native command. It must be small and exact.
func TestTrustedAppOriginAcceptsOnlyThisApplication(t *testing.T) {
	for _, test := range []struct {
		name       string
		url        string
		production bool
		want       string
	}{
		{"the pinned hosted origin", ReleaseOrigin + "/rooms/1", false, ReleaseOrigin},
		{"the Wails asset scheme", "wails://wails/index.html", false, "wails://wails"},
		{"the WebView2 virtual host", "http://wails.localhost/", false, "http://wails.localhost"},
		{"the virtual host over https", "https://wails.localhost/index.html", false, "https://wails.localhost"},
		{"the dev server in development", "http://localhost:5173/", true, "http://localhost:5173"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := TrustedAppOrigin(test.url, test.production)
			if err != nil {
				t.Fatalf("TrustedAppOrigin(%q): %v", test.url, err)
			}
			if got != test.want {
				t.Errorf("origin = %q, want %q", got, test.want)
			}
		})
	}
}

func TestTrustedAppOriginRejectsEverythingElse(t *testing.T) {
	for _, test := range []struct {
		name        string
		url         string
		development bool
	}{
		{"an identity provider", "https://api.workos.com/sso/authorize", false},
		{"a lookalike host", "https://wails.localhost.example.com/", false},
		{"a subdomain of the virtual host", "http://evil.wails.localhost/", false},
		{"the virtual host on a port", "http://wails.localhost:8080/", false},
		{"the hosted origin over http", "http://app.bettrcomms.com/", false},
		{"the hosted host on another port", "https://app.bettrcomms.com:8443/", false},
		{"the dev server in a release build", "http://localhost:5173/", false},
		{"another localhost port in development", "http://localhost:3000/", true},
		{"a file URL", "file:///C:/Windows/System32/", true},
		{"a data URL", "data:text/html,<script>fetch('/api')</script>", true},
		{"a relative URL", "/rooms/1", true},
		{"nothing", "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := TrustedAppOrigin(test.url, test.development); err == nil {
				t.Errorf("TrustedAppOrigin(%q) was accepted", test.url)
			}
		})
	}
}

// The origin the policy returns is what a permission record would be keyed on,
// so it must carry the port and drop everything below the authority.
func TestTrustedAppOriginReturnsABareOrigin(t *testing.T) {
	got, err := TrustedAppOrigin("http://localhost:5173/rooms/7?join=1#top", true)
	if err != nil {
		t.Fatalf("TrustedAppOrigin: %v", err)
	}
	if got != "http://localhost:5173" {
		t.Errorf("origin = %q, want the bare origin with its port", got)
	}
}

// The hosted origin here and the one the Rust host pins must stay identical, or
// the two hosts would trust different deployments.
func TestTheHostedOriginIsTheOneBothHostsPin(t *testing.T) {
	if ReleaseOrigin != "https://app.bettrcomms.com" {
		t.Errorf("ReleaseOrigin = %q; it must stay byte-identical to the Rust host's RELEASE_ORIGIN", ReleaseOrigin)
	}
	if _, err := TrustedAppOrigin(ReleaseOrigin, false); err != nil {
		t.Errorf("the pinned origin is not trusted by its own policy: %v", err)
	}
}
