package desktop

import (
	"runtime"
	"strings"
	"testing"
)

// TestEveryCapabilityExplainsItself is the honesty guard for this host.
//
// A capability may only be Implemented where an acceptance test exercises it
// here; tests for another host are not evidence, because hosts share no
// media code. Anything unavailable must also name what the frontend does
// instead, so a missing feature reads as a choice rather than a hole.
func TestEveryCapabilityExplainsItself(t *testing.T) {
	report := NewMediaCapabilities()

	every := map[string]Capability{
		"browserMedia":        report.BrowserMedia,
		"nativeGameVideo":     report.NativeGameVideo,
		"nativeProcessAudio":  report.NativeProcessAudio,
		"nativeMicrophoneDsp": report.NativeMicrophoneDSP,
		"localTrackRecording": report.LocalTrackRecording,
		"mediaPermissions":    report.MediaPermissions,
		"globalInput":         report.GlobalInput,
		"nativeOverlays":      report.NativeOverlays,
	}
	for name, capability := range every {
		switch capability.State {
		case Implemented, Experimental, Unavailable:
		default:
			t.Errorf("%s = %q, which is not a state the frontend knows", name, capability.State)
		}
		if capability.Detail == "" {
			t.Errorf("%s has no detail; every capability must say what will happen", name)
		}
		if capability.State == Unavailable && capability.Fallback == "" {
			t.Errorf("%s has no fallback; the frontend needs to know what happens instead", name)
		}
	}
}

// Permission policy is Experimental on Windows and macOS, not Implemented.
// Packaged camera/microphone acceptance and grant management remain separate.
func TestMediaPermissionsClaimsOnlyWhatThisHostDoes(t *testing.T) {
	permissions := NewMediaCapabilities().MediaPermissions

	if runtime.GOOS == "darwin" {
		if permissions.State != Experimental {
			t.Errorf("mediaPermissions = %q on macOS, want experimental", permissions.State)
		}
		for _, promise := range []string{"bundled BetterComms page", "macOS still asks", "acceptance remains pending"} {
			if !strings.Contains(permissions.Detail, promise) {
				t.Errorf("the detail does not say it is %q: %q", promise, permissions.Detail)
			}
		}
		return
	}
	if runtime.GOOS != "windows" {
		if permissions.State != Unavailable {
			t.Errorf("mediaPermissions = %q off Windows, want unavailable", permissions.State)
		}
		return
	}
	if permissions.State != Experimental {
		t.Errorf("mediaPermissions = %q on Windows, want experimental", permissions.State)
	}
	for _, promise := range []string{"prompt when needed", "cannot be revoked", "Navigation restriction"} {
		if !strings.Contains(permissions.Detail, promise) {
			t.Errorf("the detail does not say it is %q: %q", promise, permissions.Detail)
		}
	}
}

// TestTheOverlayIsExperimentalOnWindows covers both overlay surfaces.
//
// They are Experimental rather than Implemented on purpose: the layered
// windows, their placement and their capture exclusion are tested here, but no
// person has yet watched either surface during a call.
func TestTheOverlayIsExperimentalOnWindows(t *testing.T) {
	overlays := NewMediaCapabilities().NativeOverlays

	if overlays.Detail == "" {
		t.Error("nativeOverlays has no detail")
	}
	if runtime.GOOS == "windows" {
		if overlays.State != Experimental {
			t.Errorf("nativeOverlays = %q on Windows, want experimental", overlays.State)
		}
		return
	}
	if overlays.State != Unavailable {
		t.Errorf("nativeOverlays = %q off Windows, want unavailable", overlays.State)
	}
	if overlays.Fallback == "" {
		t.Error("nativeOverlays has no fallback off Windows")
	}
}

// TestPortedCapabilitiesAreImplementedOnWindows covers the three adapters that
// have been ported and have acceptance tests here:
//
//   - nativeGameVideo: internal/native/nativescreen capture and
//     internal/native/nativertc end-to-end viewer tests
//   - nativeProcessAudio: internal/native/systemaudio activation and capture
//   - nativeMicrophoneDsp: internal/native/deepfilter real DirectML inference
//   - localTrackRecording: internal/native/nativescreen recording test
//   - globalInput: internal/native/pushtotalk hook tests
//
// Off Windows media remains unavailable. macOS input is permission-gated and
// experimental until physical packaged acceptance passes there.
func TestPortedCapabilitiesAreImplementedOnWindows(t *testing.T) {
	report := NewMediaCapabilities()

	ported := map[string]Capability{
		"nativeGameVideo":     report.NativeGameVideo,
		"nativeProcessAudio":  report.NativeProcessAudio,
		"nativeMicrophoneDsp": report.NativeMicrophoneDSP,
		"localTrackRecording": report.LocalTrackRecording,
		"globalInput":         report.GlobalInput,
	}
	for name, capability := range ported {
		if capability.Detail == "" {
			t.Errorf("%s has no detail", name)
		}
		if runtime.GOOS == "windows" {
			if capability.State != Implemented {
				t.Errorf("%s = %q on Windows, want implemented", name, capability.State)
			}
			if capability.Fallback != "" {
				t.Errorf("%s is implemented but advertises the fallback %q", name, capability.Fallback)
			}
			continue
		}
		if name == "globalInput" && runtime.GOOS == "darwin" {
			if capability.State != Experimental || !strings.Contains(capability.Detail, "Input Monitoring") {
				t.Fatalf("macOS global input missing permission boundary: %+v", capability)
			}
			continue
		}
		if capability.State != Unavailable {
			t.Errorf("%s = %q off Windows, want unavailable", name, capability.State)
		}
		if capability.Fallback == "" {
			t.Errorf("%s has no fallback off Windows", name)
		}
	}
}

func TestBrowserMediaIsAlwaysAvailable(t *testing.T) {
	report := NewMediaCapabilities()
	if report.BrowserMedia.State != Implemented {
		t.Errorf("browserMedia = %q, want implemented", report.BrowserMedia.State)
	}
	if report.BrowserMedia.Fallback != "" {
		t.Error("an implemented capability should not advertise a fallback")
	}
	if report.SchemaVersion != 1 {
		t.Errorf("schemaVersion = %d, want 1", report.SchemaVersion)
	}
	if report.Platform != runtime.GOOS || report.Architecture != runtime.GOARCH {
		t.Errorf("report describes %s/%s, want %s/%s",
			report.Platform, report.Architecture, runtime.GOOS, runtime.GOARCH)
	}
	if len(report.Notes) == 0 {
		t.Error("the report must carry its scope notes")
	}
}

// TestDefaultWindowControlsMatchTheFrontendContract keeps the injected value
// inside the shape apps/web/src/features/shell/windowControls.ts accepts. A
// value outside it is discarded by the page, which would leave the window with
// no way to close on a frameless platform.
func TestDefaultWindowControlsMatchTheFrontendContract(t *testing.T) {
	controls := DefaultWindowControls()

	if !isOneOf(controls.Platform, "windows", "macos", "linux", "unknown") {
		t.Errorf("platform = %q", controls.Platform)
	}
	if !isOneOf(controls.Mode, "native-frame", "native-overlay", "native-traffic-lights", "client-side") {
		t.Errorf("mode = %q", controls.Mode)
	}
	if !isOneOf(controls.ButtonSide, "start", "end") {
		t.Errorf("buttonSide = %q", controls.ButtonSide)
	}
	if controls.Height <= 0 || controls.InsetStart < 0 || controls.InsetEnd < 0 {
		t.Errorf("sizes must be non-negative and the bar must have height: %+v", controls)
	}
	for _, button := range controls.Buttons {
		if !isOneOf(button, "minimize", "maximize", "close") {
			t.Errorf("button = %q", button)
		}
	}

	// A frameless window must ask the page for a full set of buttons; a decorated
	// one must not draw a competing set.
	switch controls.Mode {
	case "client-side":
		if len(controls.Buttons) != 3 {
			t.Errorf("client-side mode needs all three buttons, got %v", controls.Buttons)
		}
	default:
		if len(controls.Buttons) != 0 {
			t.Errorf("%s mode must not draw page buttons, got %v", controls.Mode, controls.Buttons)
		}
	}
}

func isOneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
