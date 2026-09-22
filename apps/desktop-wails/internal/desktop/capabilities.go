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
// A field here is Implemented only when this host has an acceptance test that
// exercises it on this host. A passing Tauri test is not evidence: the two
// hosts share no media code. Promoting a field without such a test is what
// capabilities_test.go exists to prevent.
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
	APIOriginError string `json:"apiOriginError,omitempty"`
	// APIBase is the loopback origin the frontend must send API and WebSocket
	// traffic to in a packaged build, because the page's own origin serves no
	// API and the upstream session cookie is SameSite=Lax. Empty in development,
	// where the Vite proxy already serves /api same-origin.
	APIBase string `json:"apiBase,omitempty"`
	// APIToken authorises every request to APIBase. The listener is loopback and
	// therefore reachable by any local process, so this secret — regenerated each
	// launch — is what identifies the frontend.
	APIToken string `json:"apiToken,omitempty"`
	// PageToken is what a native call must present to prove it came from a
	// document this host served. It stands in for the per-call origin check the
	// Tauri host makes, which is not possible here: see PageGate.
	PageToken  string     `json:"pageToken,omitempty"`
	AuthReturn Capability `json:"authReturn"`
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
		NativeGameVideo:     nativeGameVideo(),
		NativeProcessAudio:  nativeProcessAudio(),
		NativeMicrophoneDSP: nativeMicrophoneDSP(),
		LocalTrackRecording: localTrackRecording(),
		MediaPermissions:    mediaPermissions(),
		GlobalInput:         globalInput(),
		NativeOverlays:      nativeOverlays(),
		Notes: []string{
			"native capture, native H.264 senders, native MP4 recording and global input are ported to this host and have acceptance tests here",
			"process-loopback audio, GPU denoisers, permission IPC and the overlays are not ported and take their browser path",
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
	// Matches TITLEBAR_HEIGHT in windowControls.ts: the bar holds a search
	// field and the notification button, not just a title.
	const titlebarHeight = 40
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

// nativeGameVideo describes native screen capture on this host.
//
// Windows Graphics Capture runs through the bundled FFmpeg runtime into a
// hardware H.264 encoder, and the encoded access units go straight to WebRTC.
// Exercised by nativescreen's capture acceptance test and nativertc's
// end-to-end viewer test.
func nativeGameVideo() Capability {
	if runtime.GOOS != "windows" {
		return Capability{
			State:    Unavailable,
			Detail:   "No native capture adapter exists for this platform.",
			Fallback: "browser getDisplayMedia",
		}
	}
	return Capability{
		State:  Implemented,
		Detail: "Windows Graphics Capture shares windows and displays through a native H.264 WebRTC sender. Exclusive-game hooks are not implemented. Probe the encoder capabilities for what this machine can actually run.",
	}
}

// localTrackRecording describes native recording on this host.
//
// The capture's access units are remuxed to MP4 without a second encode.
// Exercised by nativescreen's real capture-to-MP4 acceptance test.
func localTrackRecording() Capability {
	if runtime.GOOS != "windows" {
		return Capability{
			State:    Unavailable,
			Detail:   "Native recording depends on native capture, which this platform has none of.",
			Fallback: "browser MediaRecorder into the existing IndexedDB recording library",
		}
	}
	return Capability{
		State:  Implemented,
		Detail: "The native screen capture is remuxed to MP4 without re-encoding. Other independent tracks use browser recording. Continuous rewind and active-recording crash recovery remain unavailable.",
	}
}

// globalInput describes background push-to-talk on this host.
//
// A low-level keyboard or mouse hook observes one binding without capturing
// characters or suppressing input. Exercised by pushtotalk's hook installation
// and lease tests.
func globalInput() Capability {
	if runtime.GOOS != "windows" {
		return Capability{
			State:    Unavailable,
			Detail:   "Global keyboard and mouse hooks are not available on this platform, so background push-to-talk does not work here.",
			Fallback: "foreground push-to-talk using page key events, released on focus loss",
		}
	}
	return Capability{
		State:  Implemented,
		Detail: "A leased low-level hook watches one key or mouse button while the app is in the background. It captures no characters and suppresses no input, so games keep receiving the same events.",
	}
}

// mediaPermissions describes how microphone and camera access is granted here.
//
// The Tauri host writes a per-origin allow through WebView2's Profile4 IPC and
// re-checks the page's origin on every native call. Neither is reachable from
// Go: Wails keeps its WebView2 controller private, and exposes no way to read
// the window's current URL.
//
// This host reaches the same end state differently. The window is configured to
// allow capture without prompting, which is what the Profile4 write achieves;
// native calls are gated on a per-launch token only a document this host served
// can hold, which is what the origin check achieves. Both are narrower in one
// respect and wider in another, and the detail says which.
//
// Experimental, not Implemented: the token gate and the privacy-settings
// mapping have tests, but nobody has watched a packaged window open a
// microphone without a prompt.
func mediaPermissions() Capability {
	if runtime.GOOS != "windows" {
		return Capability{
			State:    Unavailable,
			Detail:   "Microphone and camera permission is the webview's own on this platform, and this host does not manage it.",
			Fallback: "the webview's built-in permission prompt",
		}
	}
	return Capability{
		State: Experimental,
		Detail: "WebView2 applies its normal microphone and camera permission decision, including a prompt when needed; this host does not automatically allow every document. " +
			"Stored grants cannot be revoked or inspected by this host at runtime. Navigation restriction and packaged prompt acceptance remain pending. " +
			"Windows privacy settings also apply and can be opened from this host.",
	}
}

// nativeOverlays describes the always-on-top camera tile on this host.
//
// It is a layered window this process paints, excluded from screen capture so
// sharing a display does not show the viewer the overlay drawn over their own
// share. Exercised by overlay's real window and display-affinity tests.
//
// The visual-copilot signal overlay is a second surface in the same package,
// which is why the detail names what is and is not here.
func nativeOverlays() Capability {
	if runtime.GOOS != "windows" {
		return Capability{
			State:    Unavailable,
			Detail:   "The always-on-top camera overlay is a layered window with no equivalent on this platform.",
			Fallback: "in-app presentation inside the call stage",
		}
	}
	return Capability{
		State:  Experimental,
		Detail: "The always-on-top camera tile and the visual-copilot signal overlay are both available and both excluded from screen capture. The tile is click-through and paced to 24 fps; signals follow the shared window, hide while it is behind another one, and close when nothing refreshes them. Neither surface has had an interactive acceptance pass.",
	}
}

// nativeProcessAudio describes process-loopback audio on this host.
//
// Ordinary loopback records the whole endpoint, which during a call means
// recording the other participants and sending them back. Process loopback
// either targets one application's tree or excludes this one's, which is what
// makes sharing system audio during a call possible at all. Exercised by
// systemaudio's real activation and capture tests.
func nativeProcessAudio() Capability {
	if runtime.GOOS != "windows" {
		return Capability{
			State:    Unavailable,
			Detail:   "Process-loopback audio is a Windows facility with no equivalent on this platform.",
			Fallback: "browser display-capture audio, subject to the webview's own scope",
		}
	}
	return Capability{
		State:  Implemented,
		Detail: "Windows process loopback captures system output while excluding the BetterComms process tree, or captures one application's tree. It requires Windows build 20348 or newer; the capability probe reports what this machine has.",
	}
}

// nativeMicrophoneDSP describes the GPU denoisers on this host.
//
// DeepFilterNet through DirectML is the one that carries the claim: it is
// exercised end to end by deepfilter's tests, which load the real model onto
// this machine's adapter and check it keeps inside its real-time budget.
//
// NVIDIA Audio Effects is also ported, but deliberately not part of the claim.
// It has never denoised a frame here — this workspace has no NVIDIA GPU and no
// SDK — and code existing is not evidence that it runs.
func nativeMicrophoneDSP() Capability {
	if runtime.GOOS != "windows" {
		return Capability{
			State:    Unavailable,
			Detail:   "The GPU denoisers are Windows facilities with no equivalent on this platform.",
			Fallback: "browser-side RNNoise, SpeexDSP, DeepFilterNet WASM, or standard webview processing",
		}
	}
	return Capability{
		State: Implemented,
		Detail: "DeepFilterNet3 runs on the selected AMD or Intel adapter through DirectML, once the optional package is installed; the status probe reports which adapter and whether this machine can run it. " +
			"NVIDIA Audio Effects is written and has a hardware acceptance test, but no NVIDIA GPU has ever run it — it reports itself unavailable rather than claiming otherwise.",
	}
}
