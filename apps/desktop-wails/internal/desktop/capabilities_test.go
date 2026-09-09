package desktop

import (
	"runtime"
	"testing"
)

// TestNativeCapabilitiesAreReportedUnavailable is the honesty guard for this
// host. No native media adapter has been ported from apps/desktop, so none may
// be reported as working. If a capability is genuinely implemented here later,
// change it only together with an acceptance test that exercises it on this
// host; a passing Tauri test is not evidence for this one.
func TestNativeCapabilitiesAreReportedUnavailable(t *testing.T) {
	report := NewMediaCapabilities()

	native := map[string]Capability{
		"nativeGameVideo":     report.NativeGameVideo,
		"nativeProcessAudio":  report.NativeProcessAudio,
		"nativeMicrophoneDsp": report.NativeMicrophoneDSP,
		"localTrackRecording": report.LocalTrackRecording,
		"mediaPermissions":    report.MediaPermissions,
		"globalInput":         report.GlobalInput,
		"nativeOverlays":      report.NativeOverlays,
	}
	for name, capability := range native {
		if capability.State != Unavailable {
			t.Errorf("%s = %q, want unavailable", name, capability.State)
		}
		if capability.Detail == "" {
			t.Errorf("%s has no detail; an unavailable capability must say why", name)
		}
		if capability.Fallback == "" {
			t.Errorf("%s has no fallback; the frontend needs to know what happens instead", name)
		}
	}
}

func TestBrowserMediaIsTheOnlyImplementedPath(t *testing.T) {
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
