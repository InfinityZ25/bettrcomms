// Package desktop holds the parts of the Wails host that are independent of
// the Wails runtime: API-origin policy, the capability report, the asset
// pipeline, and the boot contract the shared web frontend reads.
//
// Nothing in this package imports Wails. That keeps the security boundary and
// the capability report testable with `go test` alone, and it keeps the
// Wails-specific surface confined to main.go.
package desktop

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ReleaseOrigin is the pinned hosted deployment. It must stay byte-identical
// to RELEASE_ORIGIN in apps/desktop/src-tauri/src/media_permissions.rs so both
// desktop hosts trust exactly the same production origin.
const ReleaseOrigin = "https://app.bettrcomms.com"

// ErrMissingAPIOrigin reports an empty origin in a build that has no default.
var ErrMissingAPIOrigin = errors.New("BETTERCOMMS_API_ORIGIN is required in production builds")

// ResolveAPIOrigin applies the desktop transport policy to a configured API
// origin and returns its canonical serialization.
//
// The rules mirror the Tauri host's desktop_boot_config: HTTPS is required,
// plaintext loopback is tolerated only in development builds, and the value
// must carry nothing but scheme, host, and an optional port. Credentials, a
// path, a query, or a fragment are rejected rather than silently trimmed,
// because each of them would change where session material is sent.
func ResolveAPIOrigin(raw string, allowLoopbackHTTP bool) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ErrMissingAPIOrigin
	}

	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("BETTERCOMMS_API_ORIGIN is not a valid URL: %w", err)
	}
	if !parsed.IsAbs() || parsed.Host == "" {
		return "", errors.New("BETTERCOMMS_API_ORIGIN must be an absolute http(s) URL")
	}

	scheme := strings.ToLower(parsed.Scheme)
	switch scheme {
	case "https":
	case "http":
		if !allowLoopbackHTTP || !isLoopbackHost(parsed.Hostname()) {
			return "", errors.New("the desktop API origin must use HTTPS (debug loopback HTTP is allowed)")
		}
	default:
		return "", fmt.Errorf("unsupported desktop API origin scheme %q", parsed.Scheme)
	}

	if parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.Opaque != "" {
		return "", errors.New("the desktop API origin must contain only scheme, host, and optional port")
	}

	return scheme + "://" + strings.ToLower(parsed.Host), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// AppOriginError reports a page that is not this application's own.
var AppOriginError = errors.New("native commands are restricted to the BetterComms app origin")

// TrustedAppOrigin validates that a page URL belongs to this application and
// returns its origin.
//
// This is the same policy the Rust host applies, with this host's own asset
// origins in place of Tauri's. It matters because a webview that has navigated
// to an identity provider is still the same webview: without this check, a page
// the application does not control could reach a native command.
//
// The trusted set is deliberately small:
//
//   - the pinned hosted origin, which is where the packaged app's own pages live
//   - the Wails asset scheme, which serves the embedded frontend
//   - the WebView2 virtual host the Windows backend serves that frontend from
//   - in a development build only, the Vite dev server
func TrustedAppOrigin(current string, allowDevelopment bool) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(current))
	if err != nil || !parsed.IsAbs() {
		return "", AppOriginError
	}
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Hostname())
	port := parsed.Port()

	switch {
	case scheme == "https" && originOf(parsed) == ReleaseOrigin:
		// The hosted deployment, matched on the whole origin rather than the
		// host alone so a different port is not accepted.
	case scheme == "wails":
		// The asset scheme the macOS and Linux backends serve the frontend from.
	case (scheme == "http" || scheme == "https") && host == "wails.localhost" && port == "":
		// The WebView2 virtual host the Windows backend uses.
	case allowDevelopment && scheme == "http" && host == "localhost" && port == "5173":
		// The Vite dev server, in development builds only.
	default:
		return "", AppOriginError
	}
	return originOf(parsed), nil
}

// originOf serialises a URL's origin, which is what the trust decision and the
// permission record are keyed on.
func originOf(parsed *url.URL) string {
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Host)
	if host == "" {
		// An opaque scheme such as wails:// has no authority; its origin is the
		// scheme itself.
		return scheme + "://"
	}
	return scheme + "://" + host
}
