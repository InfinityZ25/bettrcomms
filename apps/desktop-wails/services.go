package main

import (
	"context"
	"errors"

	"bettercomms/desktop-wails/internal/desktop"
	"bettercomms/desktop-wails/internal/native/audiostream"
	"bettercomms/desktop-wails/internal/native/deepfilter"
	"bettercomms/desktop-wails/internal/native/dspsetup"
	"bettercomms/desktop-wails/internal/native/ffmpegsetup"
	"bettercomms/desktop-wails/internal/native/gpudevices"
	"bettercomms/desktop-wails/internal/native/nativerecording"
	"bettercomms/desktop-wails/internal/native/nativertc"
	"bettercomms/desktop-wails/internal/native/nativescreen"
	"bettercomms/desktop-wails/internal/native/nvidiaaudio"
	"bettercomms/desktop-wails/internal/native/overlay"
	"bettercomms/desktop-wails/internal/native/pushtotalk"
	"bettercomms/desktop-wails/internal/native/recordingexport"
	"bettercomms/desktop-wails/internal/native/systemaudio"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// NativeMediaService is the binding surface for the ported native media stack.
//
// Every method here is a thin shim. The behaviour lives in internal/native,
// which imports no Wails package, so all of it stays testable with `go test`
// and none of it depends on a window existing.
//
// The page never supplies a window handle, a process id, or a filesystem path.
// It names a capture source by an opaque id this host issued, and reads a
// recording by an opaque asset id, so a compromised page cannot aim capture or
// file reads at anything it was not offered.
type NativeMediaService struct {
	screen     *nativescreen.Manager
	recordings *nativerecording.Store
	exports    *recordingexport.Store
	talk       *pushtotalk.Manager
	overlays   *overlay.Manager
	copilot    *overlay.CopilotManager
	audio      *systemaudio.Manager
	nvidia     *nvidiaaudio.Engine
	deepfilter *deepfilter.Engine
	streams    *audiostream.Manager

	// app is how a save dialog is opened. Only the host sets it.
	app *application.App

	// window is what a session reports focus and events to.
	window *application.WebviewWindow
	// gate is how a native call proves it came from a document this host
	// served. It replaces the Tauri host's per-call origin check.
	gate *desktop.PageGate
}

// NewNativeMediaService wires the native stack together.
func NewNativeMediaService() (*NativeMediaService, error) {
	staging, err := nativerecording.DefaultStagingRoot()
	if err != nil {
		return nil, err
	}
	recordings := nativerecording.NewStore(staging)
	screen := nativescreen.NewManager()
	// Recording is a remux of the same access units the viewers get, so the
	// capture manager offers every frame to the store.
	screen.SetRecorder(recordings)

	return &NativeMediaService{
		screen:     screen,
		recordings: recordings,
		exports:    recordingexport.NewStore(ffmpegsetup.RuntimePath),
		talk:       pushtotalk.NewManager(),
		overlays:   overlay.NewManager(),
		// Visual-copilot signals are placed against the live capture, so the
		// overlay measures the share through the capture manager rather than
		// taking a window handle from the page.
		copilot:    overlay.NewCopilotManager(copilotGeometry(screen)),
		audio:      systemaudio.NewManager(),
		nvidia:     nvidiaaudio.NewEngine(),
		deepfilter: deepfilter.NewEngine(),
		streams:    audiostream.NewManager(),
	}, nil
}

// attach gives the service the window it reports to.
//
// Unexported on purpose: Wails generates a binding for every exported method,
// and the page has no business rebinding this service's window.
func (s *NativeMediaService) attach(app *application.App, window *application.WebviewWindow, gate *desktop.PageGate) {
	s.app = app
	s.window = window
	s.gate = gate
	s.screen.SetEndedHandler(func(sessionID, reason string) {
		window.EmitEvent("native-screen-ended", map[string]string{"sessionId": sessionID, "reason": reason})
	})
}

// ServiceShutdown releases every native resource. Wails calls it on shutdown,
// so no encoder, muxer, or input hook outlives the process.
func (s *NativeMediaService) ServiceShutdown() error {
	s.streams.Close()
	s.talk.Close()
	s.screen.Close()
	s.recordings.Close()
	s.exports.Close()
	s.overlays.Shutdown()
	s.copilot.Shutdown()
	s.audio.Close()
	s.nvidia.Close()
	s.deepfilter.Close()
	return nil
}

// authorise refuses a native call that did not come from this host's own page.
//
// The token is injected into every document the asset handler serves and
// nowhere else, so a page that navigated away cannot present it. See
// internal/desktop/pagegate.go for why this is the check and not an origin
// comparison.
func (s *NativeMediaService) authorise(hostToken string) error {
	return s.gate.Authorise(hostToken)
}

// --- Runtime setup -------------------------------------------------------

// FfmpegInstallInfo reports whether the private FFmpeg runtime is present.
func (s *NativeMediaService) FfmpegInstallInfo() ffmpegsetup.InstallInfo {
	return ffmpegsetup.Info()
}

// FfmpegInstall downloads and verifies the pinned runtime.
func (s *NativeMediaService) FfmpegInstall(ctx context.Context, hostToken string) (ffmpegsetup.InstallResult, error) {
	if err := s.authorise(hostToken); err != nil {
		return ffmpegsetup.InstallResult{}, err
	}
	return ffmpegsetup.Install(ctx)
}

// GpuAdapters lists the DirectML-capable adapters on this machine.
func (s *NativeMediaService) GpuAdapters() ([]gpudevices.Adapter, error) {
	return gpudevices.CompatibleAdapters()
}

// --- Native screen capture ----------------------------------------------

// NativeScreenCapabilities probes the encoders this machine can actually run.
func (s *NativeMediaService) NativeScreenCapabilities(ctx context.Context) nativescreen.Capabilities {
	return nativescreen.Probe(ctx)
}

// NativeScreenSources lists what can be shared.
func (s *NativeMediaService) NativeScreenSources(hostToken string) ([]nativescreen.Source, error) {
	if err := s.authorise(hostToken); err != nil {
		return nil, err
	}
	return s.screen.Sources()
}

func (s *NativeMediaService) NativeScreenThumbnail(ctx context.Context, hostToken, sourceID string) ([]byte, error) {
	if err := s.authorise(hostToken); err != nil {
		return nil, err
	}
	return s.screen.Thumbnail(ctx, sourceID)
}

// NativeScreenStart begins a capture.
func (s *NativeMediaService) NativeScreenStart(ctx context.Context, hostToken string, options nativescreen.StartOptions) (nativescreen.Started, error) {
	if err := s.authorise(hostToken); err != nil {
		return nativescreen.Started{}, err
	}
	return s.screen.Start(ctx, options)
}

// NativeScreenStop ends a capture.
func (s *NativeMediaService) NativeScreenStop(hostToken, sessionID string) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	return s.screen.Stop(sessionID)
}

// NativeScreenDiagnostics reports what a running capture is doing.
func (s *NativeMediaService) NativeScreenDiagnostics(hostToken, sessionID string) (NativeScreenReport, error) {
	if err := s.authorise(hostToken); err != nil {
		return NativeScreenReport{}, err
	}
	info, detail, err := s.screen.Diagnostics(sessionID)
	if err != nil {
		return NativeScreenReport{}, err
	}
	report := NativeScreenReport{Started: info, EncoderOutput: detail}
	if hub, err := s.screen.Hub(sessionID); err == nil {
		report.Stats = hub.Stats()
	}
	return report, nil
}

// NativeScreenReport is a capture's live state.
type NativeScreenReport struct {
	nativescreen.Started
	Stats nativertc.Stats `json:"stats"`
	// EncoderOutput is the encoder's own diagnostics, which is what explains a
	// capture that started and then failed.
	EncoderOutput string `json:"encoderOutput,omitempty"`
}

// --- Native WebRTC senders ----------------------------------------------

// NativeScreenPeerOffer offers the capture to one viewer.
func (s *NativeMediaService) NativeScreenPeerOffer(
	ctx context.Context, hostToken, sessionID, peerID string,
	iceServers []nativertc.IceServer, directOnly bool,
) (nativertc.Offer, error) {
	if err := s.authorise(hostToken); err != nil {
		return nativertc.Offer{}, err
	}
	hub, err := s.screen.Hub(sessionID)
	if err != nil {
		return nativertc.Offer{}, err
	}
	return hub.CreatePeer(ctx, peerID, iceServers, directOnly)
}

// NativeScreenPeerAnswer accepts a viewer's answer.
func (s *NativeMediaService) NativeScreenPeerAnswer(hostToken, sessionID, peerID, sdp string) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	hub, err := s.screen.Hub(sessionID)
	if err != nil {
		return err
	}
	return hub.ApplyAnswer(peerID, sdp)
}

// NativeScreenPeerCandidate trickles one ICE candidate in.
func (s *NativeMediaService) NativeScreenPeerCandidate(hostToken, sessionID, peerID string, candidate nativertc.IceCandidate) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	hub, err := s.screen.Hub(sessionID)
	if err != nil {
		return err
	}
	return hub.AddCandidate(peerID, candidate)
}

// NativeScreenPeerRemove detaches one viewer.
func (s *NativeMediaService) NativeScreenPeerRemove(hostToken, sessionID, peerID string) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	hub, err := s.screen.Hub(sessionID)
	if err != nil {
		return err
	}
	return hub.RemovePeer(peerID)
}

// --- Native recording ----------------------------------------------------

// NativeScreenRecordingStart records the live capture without re-encoding it.
func (s *NativeMediaService) NativeScreenRecordingStart(hostToken, sessionID string) (nativerecording.Started, error) {
	if err := s.authorise(hostToken); err != nil {
		return nativerecording.Started{}, err
	}
	return s.recordings.Start(sessionID)
}

// NativeScreenRecordingStop finalises the MP4 and returns its handle.
func (s *NativeMediaService) NativeScreenRecordingStop(hostToken, recordingID string) (nativerecording.Asset, error) {
	if err := s.authorise(hostToken); err != nil {
		return nativerecording.Asset{}, err
	}
	return s.recordings.Stop(recordingID)
}

// NativeScreenRecordingRead returns one chunk of a finished recording. The page
// never learns where the file lives.
func (s *NativeMediaService) NativeScreenRecordingRead(hostToken, assetID string, offset int64, length int) ([]byte, error) {
	if err := s.authorise(hostToken); err != nil {
		return nil, err
	}
	return s.recordings.Read(assetID, offset, length)
}

// NativeScreenRecordingRelease deletes a finished recording.
func (s *NativeMediaService) NativeScreenRecordingRelease(hostToken, assetID string) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	return s.recordings.Release(assetID)
}

// --- Global push-to-talk -------------------------------------------------

// PushToTalkCapabilities reports whether background push-to-talk works here.
func (s *NativeMediaService) PushToTalkCapabilities() pushtotalk.Capabilities {
	return pushtotalk.Describe()
}

// PushToTalkStart watches one key or mouse button while the app is in the
// background.
func (s *NativeMediaService) PushToTalkStart(hostToken string, binding pushtotalk.Binding) (pushtotalk.Snapshot, error) {
	if err := s.authorise(hostToken); err != nil {
		return pushtotalk.Snapshot{}, err
	}
	return s.talk.Start(binding, pushtotalk.Options{
		Emit: func(snapshot pushtotalk.Snapshot) {
			if s.window != nil {
				s.window.EmitEvent(pushtotalk.Event, snapshot)
			}
		},
		Focused: func() bool { return s.window != nil && s.window.IsFocused() },
		// The lease's own liveness check. The call was authorised at Start; what
		// this asks is whether the window is still there to hold a hook for.
		Trusted: func() bool { return s.window != nil },
	})
}

// PushToTalkHeartbeat renews the session lease.
func (s *NativeMediaService) PushToTalkHeartbeat(hostToken, sessionID string) (pushtotalk.Snapshot, error) {
	if err := s.authorise(hostToken); err != nil {
		return pushtotalk.Snapshot{}, err
	}
	return s.talk.Heartbeat(sessionID)
}

// PushToTalkStop ends the session and removes the hook.
func (s *NativeMediaService) PushToTalkStop(hostToken, sessionID string) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	return s.talk.Stop(sessionID)
}

// --- Recording export ----------------------------------------------------

// exportOwner names the window a grant belongs to, so one window's grant
// cannot be driven by another.
func (s *NativeMediaService) exportOwner(hostToken string) (string, error) {
	if err := s.authorise(hostToken); err != nil {
		return "", err
	}
	if s.window == nil {
		return "", errors.New("recording export requires the app window")
	}
	return s.window.Name(), nil
}

// chooseDestination opens the native save dialog. The page never supplies a
// path: it supplies a name to suggest, and the person picks where it goes.
func (s *NativeMediaService) chooseDestination(suggested string) (string, error) {
	if s.app == nil {
		return "", errors.New("recording export is unavailable in this host")
	}
	dialog := s.app.Dialog.SaveFile().SetFilename(suggested).CanCreateDirectories(true)
	if s.window != nil {
		dialog = dialog.AttachToWindow(s.window)
	}
	return dialog.PromptForSingleSelection()
}

// RecordingConversionCapabilities reports which conversion targets this
// machine can produce.
func (s *NativeMediaService) RecordingConversionCapabilities() recordingexport.Capabilities {
	return s.exports.Describe()
}

// RecordingExportBegin asks where to save a recording and grants the page a
// handle to stream it there. An empty grant means the person cancelled.
func (s *NativeMediaService) RecordingExportBegin(hostToken string, fileName string, sizeBytes int64) (*recordingexport.Grant, error) {
	owner, err := s.exportOwner(hostToken)
	if err != nil {
		return nil, err
	}
	destination, err := s.chooseDestination(recordingexport.SafeSuggestedName(fileName))
	if err != nil || destination == "" {
		return nil, err
	}
	grant, err := s.exports.Begin(destination, owner, sizeBytes, "")
	if err != nil {
		return nil, err
	}
	return &grant, nil
}

// RecordingConversionBegin is RecordingExportBegin for a converted copy.
func (s *NativeMediaService) RecordingConversionBegin(hostToken string, fileName string, sizeBytes int64, format string) (*recordingexport.Grant, error) {
	owner, err := s.exportOwner(hostToken)
	if err != nil {
		return nil, err
	}
	target, err := recordingexport.ParseFormat(format)
	if err != nil {
		return nil, err
	}
	destination, err := s.chooseDestination(recordingexport.SuggestedNameFor(fileName, target))
	if err != nil || destination == "" {
		return nil, err
	}
	grant, err := s.exports.Begin(destination, owner, sizeBytes, target)
	if err != nil {
		return nil, err
	}
	return &grant, nil
}

// RecordingExportAppend writes one chunk at the offset the last one ended.
func (s *NativeMediaService) RecordingExportAppend(hostToken, exportID string, offset int64, chunk []byte) error {
	owner, err := s.exportOwner(hostToken)
	if err != nil {
		return err
	}
	return s.exports.Append(exportID, owner, offset, chunk)
}

// RecordingExportFinish commits the file, converting it first when asked.
func (s *NativeMediaService) RecordingExportFinish(ctx context.Context, hostToken, exportID string) (recordingexport.Result, error) {
	owner, err := s.exportOwner(hostToken)
	if err != nil {
		return recordingexport.Result{}, err
	}
	return s.exports.Finish(ctx, exportID, owner)
}

// RecordingExportAbort discards an export the page gave up on.
func (s *NativeMediaService) RecordingExportAbort(hostToken, exportID string) error {
	owner, err := s.exportOwner(hostToken)
	if err != nil {
		return err
	}
	return s.exports.Abort(exportID, owner)
}

// --- Camera overlay ------------------------------------------------------

// CameraOverlayOpen shows the always-on-top camera tile, replacing any that was
// already open.
func (s *NativeMediaService) CameraOverlayOpen(hostToken string, options overlay.Options) (overlay.Info, error) {
	if err := s.authorise(hostToken); err != nil {
		return overlay.Info{}, err
	}
	return s.overlays.Open(options)
}

// CameraOverlayUpdate moves or resizes an open overlay.
func (s *NativeMediaService) CameraOverlayUpdate(hostToken, overlayID string, change overlay.Update) (overlay.Info, error) {
	if err := s.authorise(hostToken); err != nil {
		return overlay.Info{}, err
	}
	return s.overlays.Update(overlayID, change)
}

// CameraOverlayFrame paints one RGBA frame.
//
// The frame arrives as bytes rather than a data URL: a 320x180 tile at 24 fps
// is about 5 MB a second, and base64 would add a third to that for nothing.
func (s *NativeMediaService) CameraOverlayFrame(hostToken, overlayID string, width, height uint32, rgba []byte) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	return s.overlays.Frame(overlayID, width, height, rgba)
}

// CameraOverlayClose hides the overlay.
func (s *NativeMediaService) CameraOverlayClose(hostToken, overlayID string) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	return s.overlays.Close(overlayID)
}

// --- Visual copilot overlay ----------------------------------------------

// copilotGeometry adapts the capture manager's measurement to the shape the
// overlay package uses, so the overlay imports no capture code and stays
// testable without a share running.
func copilotGeometry(screen *nativescreen.Manager) overlay.GeometryFunc {
	return func(sessionID string, requireForeground bool) (overlay.Geometry, error) {
		measured, err := screen.CopilotGeometry(sessionID, requireForeground)
		if err != nil {
			return overlay.Geometry{}, err
		}
		return overlay.Geometry{
			Left:          measured.Left,
			Top:           measured.Top,
			Width:         measured.Width,
			Height:        measured.Height,
			EncodedWidth:  measured.EncodedWidth,
			EncodedHeight: measured.EncodedHeight,
		}, nil
	}
}

// CopilotOverlayFrame draws one visual-copilot signal over the shared source.
//
// The signal is placed against a capture session this host started, not against
// a window the page names, so a page cannot put a window at an arbitrary place
// on the desktop by claiming to be pointing at something.
func (s *NativeMediaService) CopilotOverlayFrame(hostToken string, frame overlay.CopilotFrame, rgba []byte) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	return s.copilot.Frame(frame, rgba)
}

// CopilotOverlayClear takes every signal off the desktop. The page calls it
// when the marks expire, when sharing stops, and once at startup to find out
// whether this host supports the overlay at all.
func (s *NativeMediaService) CopilotOverlayClear(hostToken string) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	s.copilot.Clear()
	return nil
}

// --- System and application audio ----------------------------------------

// NativeSystemAudioCapabilities reports whether process loopback works here.
func (s *NativeMediaService) NativeSystemAudioCapabilities() systemaudio.Capabilities {
	return systemaudio.Describe()
}

// NativeSystemAudioStart begins capturing what other applications are playing.
//
// The source id is resolved by the capture manager, so the page can only ever
// name an application it was already offered in the picker.
func (s *NativeMediaService) NativeSystemAudioStart(hostToken string, options systemaudio.StartOptions) (systemaudio.Started, error) {
	if err := s.authorise(hostToken); err != nil {
		return systemaudio.Started{}, err
	}
	return s.audio.Start(options, s.screen.AudioProcessForSource)
}

// NativeSystemAudioRead returns the next chunk of captured audio as 48 kHz
// stereo 32-bit float frames.
func (s *NativeMediaService) NativeSystemAudioRead(hostToken, sessionID string) ([]byte, error) {
	if err := s.authorise(hostToken); err != nil {
		return nil, err
	}
	return s.audio.Read(sessionID)
}

// NativeSystemAudioStop ends a capture.
func (s *NativeMediaService) NativeSystemAudioStop(hostToken, sessionID string) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	return s.audio.Stop(sessionID)
}

// --- NVIDIA Audio Effects ------------------------------------------------

// NvidiaInstallInfo reports whether this machine has hardware the pinned
// package runs on, and whether the package is already here.
//
// It answers before anything is loaded, so a settings screen can offer an
// install, say which card would be needed, or point at DeepFilterNet — rather
// than offering a several-hundred-megabyte download that would not work.
func (s *NativeMediaService) NvidiaInstallInfo() dspsetup.Info {
	return dspsetup.Describe("nvidia")
}

func (s *NativeMediaService) NvidiaInstall(ctx context.Context, hostToken string) (dspsetup.Result, error) {
	if err := s.authorise(hostToken); err != nil {
		return dspsetup.Result{}, err
	}
	result, err := dspsetup.Install(ctx, "nvidia")
	if err == nil {
		s.nvidia.InvalidateStatus()
	}
	return result, err
}

func (s *NativeMediaService) DeepfilterInstallInfo() dspsetup.Info {
	return dspsetup.Describe("deepfilter")
}

func (s *NativeMediaService) DeepfilterInstall(ctx context.Context, hostToken string) (dspsetup.Result, error) {
	if err := s.authorise(hostToken); err != nil {
		return dspsetup.Result{}, err
	}
	return dspsetup.Install(ctx, "deepfilter")
}

// NvidiaStatus reports whether the SDK is installed and whether this machine's
// GPU will actually run it.
func (s *NativeMediaService) NvidiaStatus(hostToken string) (nvidiaaudio.Status, error) {
	if err := s.authorise(hostToken); err != nil {
		return nvidiaaudio.Status{}, err
	}
	return s.nvidia.Status(), nil
}

// --- DeepFilterNet through DirectML --------------------------------------

// DeepfilterStatus reports whether the package is installed and which GPU the
// graph would run on.
func (s *NativeMediaService) DeepfilterStatus(hostToken string) (deepfilter.Status, error) {
	if err := s.authorise(hostToken); err != nil {
		return deepfilter.Status{}, err
	}
	return s.deepfilter.Status(), nil
}

// --- Microphone and camera permission ------------------------------------

// MediaPermission reports the standing policy this host configured for a
// capability, and whether it can be changed from here.
//
// The page asks so it can render the truth rather than a control that would do
// nothing: this host allows capture outright and cannot revoke it, which is a
// different shape from the Tauri host's per-origin grant.
func (s *NativeMediaService) MediaPermission(kind string) (desktop.MediaPermissionPolicy, error) {
	parsed, err := desktop.ParseMediaPermissionKind(kind)
	if err != nil {
		return desktop.MediaPermissionPolicy{}, err
	}
	return desktop.MediaPermission(parsed), nil
}

// MediaPermissionOpenSettings opens the Windows privacy page for a capability.
//
// This is where a refusal actually lives on Windows: the webview is configured
// to allow capture, so a device that will not open is being held by the
// operating system, not by this application.
func (s *NativeMediaService) MediaPermissionOpenSettings(hostToken, kind string) error {
	if err := s.authorise(hostToken); err != nil {
		return err
	}
	parsed, err := desktop.ParseMediaPermissionKind(kind)
	if err != nil {
		return err
	}
	return desktop.OpenExternal(desktop.MediaPermissionSettingsURI(parsed))
}
