package desktop

import "runtime"

// CapabilityState mirrors the Tauri host's vocabulary so the shared frontend
// can read one shape from either desktop runtime.
type CapabilityState string

const (
	// Implemented means this host has the code path and it is exercised by tests.
	Implemented CapabilityState = "implemented"
	// Experimental means the code path exists but has not met its acceptance gate.
	Experimental CapabilityState = "experimental"
	// Unavailable means this host has no such code path. The frontend must use
	// its browser fallback, or hide the control.
	Unavailable CapabilityState = "unavailable"
)

// Capability is one reported capability and the reason for its state. The
// detail is user-facing: it explains what will happen instead, not merely that
// something is missing.
type Capability struct {
	State  CapabilityState `json:"state"`
	Detail string          `json:"detail"`
	// Fallback names the frontend path used while State is "unavailable".
	Fallback string `json:"fallback,omitempty"`
}

// MediaCapabilities is the media half of the desktop report.
//
// Every native field below is deliberately Unavailable. The Wails host is a
// window and an asset server; none of the Tauri host's native media adapters
// (Windows Graphics Capture, process-loopback audio, NVIDIA Audio Effects,
// DeepFilterNet through DirectML, native H.264 senders, native MP4 recording,
// global input hooks, camera/copilot overlays) have been ported to it. Do not
// promote any of these to Implemented without a passing acceptance test on the
// Wails host itself; a passing Tauri test proves nothing here.
type MediaCapabilities struct {
	SchemaVersion int    `json:"schemaVersion"`
	Platform      string `json:"platform"`
	Architecture  string `json:"architecture"`

	BrowserMedia        Capability `json:"browserMedia"`
	NativeGameVideo     Capability `json:"nativeGameVideo"`
	NativeProcessAudio  Capability `json:"nativeProcessAudio"`
	NativeMicrophoneDSP Capability `json:"nativeMicrophoneDsp"`
	LocalTrackRecording Capability `json:"localTrackRecording"`
	MediaPermissions    Capability `json:"mediaPermissions"`
	GlobalInput         Capability `json:"globalInput"`
	NativeOverlays      Capability `json:"nativeOverlays"`

	Notes []string `json:"notes"`
}

// BootReport is what the frontend reads once, synchronously, from the page
// global the asset pipeline injects.
type BootReport struct {
	SchemaVersion int    `json:"schemaVersion"`
	Runtime       string `json:"runtime"`
	HostVersion   string `json:"hostVersion"`
	Platform      string `json:"platform"`
	Architecture  string `json:"architecture"`
	// APIOrigin is the validated origin the web client must use for HTTP and
	// WebSocket traffic. Empty means the host could not resolve one and the
	// frontend must stay on its same-origin default.
	APIOrigin string `json:"apiOrigin"`
	// APIOriginError explains an empty APIOrigin instead of hiding it.
	APIOriginError string     `json:"apiOriginError,omitempty"`
	AuthReturn     Capability `json:"authReturn"`
	// WindowControls tells the page who draws minimise/maximise/close.
	WindowControls WindowControls `json:"windowControls"`

	Capabilities MediaCapabilities `json:"capabilities"`
}

// WindowControls matches the shape apps/web/src/features/shell/windowControls.ts
// validates, so the Wails host can drive the same title bar the Tauri host
// drives without porting the better-gui plugin.
type WindowControls struct {
	Platform   string   `json:"platform"`
	Mode       string   `json:"mode"`
	Height     int      `json:"height"`
	InsetStart int      `json:"insetStart"`
	InsetEnd   int      `json:"insetEnd"`
	Buttons    []string `json:"buttons"`
	ButtonSide string   `json:"buttonSide"`
}

// NewMediaCapabilities builds the report for the running host.
func NewMediaCapabilities() MediaCapabilities {
	return MediaCapabilities{
		SchemaVersion: 1,
		Platform:      runtime.GOOS,
		Architecture:  runtime.GOARCH,
		BrowserMedia: Capability{
			State:  Implemented,
			Detail: "The webview's getUserMedia/getDisplayMedia are available. Actual device, codec, and screen-picker behaviour is the webview's, and must be probed in the web client.",
		},
		NativeGameVideo: Capability{
			State:    Unavailable,
			Detail:   "No native capture adapter is ported to the Wails host. There is no Windows Graphics Capture, no process/window enumeration, no encoder probe, and no native H.264 WebRTC sender here.",
			Fallback: "browser getDisplayMedia",
		},
		NativeProcessAudio: Capability{
			State:    Unavailable,
			Detail:   "No process-loopback audio adapter is ported to the Wails host. Per-process audio and BetterComms process-tree exclusion are not available.",
			Fallback: "browser display-capture audio, subject to the webview's own scope",
		},
		NativeMicrophoneDSP: Capability{
			State:    Unavailable,
			Detail:   "NVIDIA Audio Effects and the DirectML DeepFilterNet engine are not ported to the Wails host. No GPU denoiser runs in this process.",
			Fallback: "browser-side RNNoise, SpeexDSP, DeepFilterNet WASM, or standard webview processing",
		},
		LocalTrackRecording: Capability{
			State:    Unavailable,
			Detail:   "Native MP4 remuxing and native file export are not ported to the Wails host.",
			Fallback: "browser MediaRecorder into the existing IndexedDB recording library, with browser-side export",
		},
		MediaPermissions: Capability{
			State:    Unavailable,
			Detail:   "The Tauri host sets microphone/camera permission through WebView2 Profile4 IPC. The Wails host does not, so the webview's own permission behaviour applies.",
			Fallback: "the webview's built-in permission handling",
		},
		GlobalInput: Capability{
			State:    Unavailable,
			Detail:   "Global keyboard and mouse hooks are not ported to the Wails host, so background push-to-talk does not work here.",
			Fallback: "foreground push-to-talk using page key events, released on focus loss",
		},
		NativeOverlays: Capability{
			State:    Unavailable,
			Detail:   "The always-on-top camera overlay and the visual-copilot capture overlay are not ported to the Wails host.",
			Fallback: "in-app presentation inside the call stage",
		},
		Notes: []string{
			"this host is a window and an asset server; it contains no media code",
			"the web client must use its browser path whenever a capability is not implemented",
			"parity with apps/desktop is not claimed and has not been measured",
		},
	}
}

// DefaultWindowControls returns the title-bar contract for the running host.
//
// The Wails window is created without decorations on Windows and Linux, so the
// page draws the buttons. macOS keeps its own traffic lights and the page only
// reserves room for them.
func DefaultWindowControls() WindowControls {
	const titlebarHeight = 32
	// Matches MACOS_TRAFFIC_LIGHT_INSET in windowControls.ts.
	const macTrafficLightInset = 78

	switch runtime.GOOS {
	case "darwin":
		return WindowControls{
			Platform:   "macos",
			Mode:       "native-traffic-lights",
			Height:     titlebarHeight,
			InsetStart: macTrafficLightInset,
			Buttons:    []string{},
			ButtonSide: "start",
		}
	case "windows":
		return WindowControls{
			Platform:   "windows",
			Mode:       "client-side",
			Height:     titlebarHeight,
			Buttons:    []string{"minimize", "maximize", "close"},
			ButtonSide: "end",
		}
	default:
		return WindowControls{
			Platform:   "linux",
			Mode:       "client-side",
			Height:     titlebarHeight,
			Buttons:    []string{"minimize", "maximize", "close"},
			ButtonSide: "end",
		}
	}
}
