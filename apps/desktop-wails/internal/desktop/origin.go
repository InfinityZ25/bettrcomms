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
const ReleaseOrigin = "https://bettrcomms-production.up.railway.app"

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
