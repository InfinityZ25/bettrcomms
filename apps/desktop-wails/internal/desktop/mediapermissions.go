package desktop

import (
	"fmt"
	"strings"
)

// Microphone and camera permission on this host.
//
// The Tauri host drives WebView2's Profile4 permission IPC: it writes an
// allow or a deny for the application's origin and reads it back. That
// interface is not reachable from here — Wails keeps its WebView2 controller
// private, and the package that wraps it is internal to Wails. This host does
// not yet have equivalent grant inspection/revocation.
//
// It defers microphone/camera requests to WebView2's normal permission decision
// rather than automatically allowing every document in the window. Opening
// sign-in externally does not prevent other navigation. A persisted permission
// may already exist; this report is policy, not a claim that a prompt appeared.
//
// What is deliberately not claimed: this host cannot revoke the grant at
// runtime, and cannot read back what WebView2 has stored. Windows' own privacy
// settings can also refuse a device; MediaPermissionSettingsURI opens them.

// MediaPermissionKind is a capability the page can ask for.
type MediaPermissionKind string

const (
	MicrophonePermission MediaPermissionKind = "microphone"
	CameraPermission     MediaPermissionKind = "camera"
)

// MediaPermissionPolicy is what this host configured, and what it cannot do.
type MediaPermissionPolicy struct {
	Kind MediaPermissionKind `json:"kind"`
	// Policy is the configured decision strategy, not a stored grant status.
	Policy string `json:"policy"`
	// Managed reports whether this host can change the policy at runtime. It is
	// false here, and the page should not offer a control that would do
	// nothing.
	Managed bool `json:"managed"`
	// Detail is what to tell the person when capture fails anyway.
	Detail string `json:"detail"`
}

// ParseMediaPermissionKind narrows what the page asked for.
func ParseMediaPermissionKind(raw string) (MediaPermissionKind, error) {
	switch MediaPermissionKind(strings.ToLower(strings.TrimSpace(raw))) {
	case MicrophonePermission:
		return MicrophonePermission, nil
	case CameraPermission:
		return CameraPermission, nil
	}
	return "", fmt.Errorf("unknown media permission %q", raw)
}

// MediaPermission describes this host's standing policy for one capability.
func MediaPermission(kind MediaPermissionKind) MediaPermissionPolicy {
	device := "microphone"
	if kind == CameraPermission {
		device = "camera"
	}
	return MediaPermissionPolicy{
		Kind:    kind,
		Policy:  "default",
		Managed: false,
		Detail: "WebView2 applies its normal permission decision for the " + device +
			", including a prompt when needed. Windows privacy settings also apply. This host cannot read or revoke a stored grant.",
	}
}

// MediaPermissionSettingsURI is the Windows privacy page for a capability.
//
// Returned rather than launched here so the launching stays in one place with
// the rest of this host's shell integration, and so the mapping itself is
// testable without opening anything.
func MediaPermissionSettingsURI(kind MediaPermissionKind) string {
	if kind == CameraPermission {
		return "ms-settings:privacy-webcam"
	}
	return "ms-settings:privacy-microphone"
}

// OpenExternal hands a URI to the operating system's own handler.
//
// The scheme is checked rather than passed through. This function is reachable
// from the page, and the shell will happily run whatever a scheme is registered
// to — file:, and on Windows anything an installed application claimed. Only
// the three this application actually needs are allowed through.
func OpenExternal(target string) error {
	scheme, _, found := strings.Cut(target, ":")
	if !found {
		return fmt.Errorf("%q is not an address this host can open", target)
	}
	switch strings.ToLower(scheme) {
	case "https", "http", "ms-settings":
	default:
		return fmt.Errorf("this host will not open %q addresses", scheme)
	}
	return shellOpen(target)
}
