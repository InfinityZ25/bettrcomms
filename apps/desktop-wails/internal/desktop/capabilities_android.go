//go:build android

package desktop

// SDK availability is supplied by the application JNI host, without coupling
// the desktop contract package to the application's media implementation.
var AndroidMetaCameraAvailable func() bool

func configurePlatformCapabilities(report *MediaCapabilities) {
	report.BrowserMedia = Capability{State: Experimental, Detail: "Android WebView microphone and phone camera capture require native runtime permission. Screen capture uses MediaProjection, not getDisplayMedia."}
	report.NativeGameVideo = Capability{State: Experimental, Detail: "Android MediaProjection shares a selected app or the phone screen through native H.264 and WebRTC after system consent. Protected content is excluded. System audio is not yet captured."}
	report.MediaPermissions = Capability{State: Experimental, Detail: "Only the bundled BetterComms page can request camera or microphone access; Android runtime permissions are checked before the WebView grant."}
	report.NativeMetaCamera = &Capability{State: Unavailable, Detail: "Glasses video requires the Meta build on Android 12 or later."}
	if AndroidMetaCameraAvailable != nil && AndroidMetaCameraAvailable() {
		report.NativeMetaCamera = &Capability{State: Experimental, Detail: "Meta DAT 1.0 uses native glasses capture and H.264 sending. Physical-device acceptance remains required."}
	}
	report.Notes = []string{"Android native capture and SDK bindings are experimental until device acceptance passes", "Phone cameras and call microphone transport still use WebView WebRTC; background audio needs device acceptance", "Windows native DSP, process audio and overlays are not available on Android"}
}
