package nativescreen

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"bettercomms/desktop-wails/internal/native/ffmpegsetup"
	"bettercomms/desktop-wails/internal/native/h264"
	"bettercomms/desktop-wails/internal/native/nativeprocess"
	"bettercomms/desktop-wails/internal/native/nativertc"
)

// maxDiagnosticsBytes bounds the encoder's captured stderr. It is a ring for
// reporting a failure, not a log.
const maxDiagnosticsBytes = 16 * 1024

// encoderProbeTimeout bounds one encoder's two-frame trial encode.
const encoderProbeTimeout = 10 * time.Second

// ErrRuntimeMissing tells the page what to do about it, because the picker has
// a button that does exactly that.
var ErrRuntimeMissing = errors.New("Native sharing needs its FFmpeg 8.1 runtime. Use Install native sharing runtime in the screen picker.")

// session is one running capture.
type session struct {
	source   Source
	info     Started
	hub      *nativertc.Hub
	cmd      *exec.Cmd
	cancel   context.CancelFunc
	stopped  atomic.Bool
	done     chan struct{}
	recorder Recorder

	diagnosticsMu sync.Mutex
	diagnostics   []byte
}

// Recorder is the recording store a capture offers its access units to.
//
// It is an interface so this package holds no recording implementation: the
// same encoded frames that go to viewers are simply offered to whatever is
// recording, and nothing here knows how they are muxed.
type Recorder interface {
	RegisterSession(sessionID string, fps uint32, ffmpeg string) error
	FeedAccessUnit(sessionID string, unit []byte)
	CaptureEnded(sessionID string)
}

// Manager owns the source catalogue and the single active capture.
type Manager struct {
	mu       sync.Mutex
	sources  map[string]Source
	active   *session
	recorder Recorder
}

// NewManager returns a manager with no capture running.
func NewManager() *Manager { return &Manager{sources: map[string]Source{}} }

// SetRecorder attaches a recording store. Captures started afterwards offer
// their access units to it.
func (m *Manager) SetRecorder(recorder Recorder) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.recorder = recorder
}

// ffmpegPath resolves the encoder this host will run.
//
// Only a runtime this application installed or shipped is used. A path from the
// page, or anything found on PATH, is never executed: this process spawns it
// with the user's privileges.
func ffmpegPath() (string, error) {
	if path := ffmpegsetup.RuntimePath(); path != "" {
		return path, nil
	}
	// A known installed distribution is the one other acceptable source.
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return "", ErrRuntimeMissing
	}
	base := filepath.Join(local, "Microsoft", "WinGet", "Packages",
		"Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
	entries, err := os.ReadDir(base)
	if err != nil {
		return "", ErrRuntimeMissing
	}
	var candidates []string
	for _, entry := range entries {
		candidate := filepath.Join(base, entry.Name(), "bin", "ffmpeg.exe")
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			candidates = append(candidates, candidate)
		}
	}
	if len(candidates) == 0 {
		return "", ErrRuntimeMissing
	}
	sort.Strings(candidates)
	return candidates[len(candidates)-1], nil
}

// Probe reports which encoders this machine can actually run.
//
// Every encoder is trialled with a real two-frame encode rather than read off a
// capability list: a driver can advertise an encoder it then refuses to
// initialise, and finding that out at share time is too late.
func Probe(ctx context.Context) Capabilities {
	path, err := ffmpegPath()
	if err != nil {
		return Capabilities{Detail: err.Error(), Version: 1}
	}

	encoders := make([]Encoder, 0, len(knownEncoders))
	var anyAvailable bool
	for _, candidate := range knownEncoders {
		available := trialEncode(ctx, path, candidate.id)
		anyAvailable = anyAvailable || available
		reason := "Encoder or compatible driver is unavailable"
		if available {
			reason = "Native encoder probe passed"
		}
		encoders = append(encoders, Encoder{
			ID:        candidate.id,
			Label:     candidate.label,
			Available: available,
			Reason:    reason,
		})
	}
	return Capabilities{
		Available: supportedPlatform && anyAvailable,
		Detail:    "Windows Graphics Capture. H.264 encoder selection controls the outgoing stream. Optional system audio excludes BetterComms and requires Windows build 20348 or newer.",
		Encoders:  encoders,
		Version:   1,
	}
}

// trialEncode runs two frames of colour bars through one encoder.
func trialEncode(ctx context.Context, path, encoder string) bool {
	ctx, cancel := context.WithTimeout(ctx, encoderProbeTimeout)
	defer cancel()

	args := []string{
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=size=1280x720:rate=30",
		"-frames:v", "2",
	}
	args = append(args, encoderArgs(encoder, 30, 10, h264.Baseline)...)
	args = append(args, "-f", "null", "-")

	cmd := exec.CommandContext(ctx, path, args...)
	hideWindow(cmd)
	cmd.Stdin = nil
	return cmd.Run() == nil
}

// Sources enumerates what can be shared, keeping ids stable across refreshes.
func (m *Manager) Sources() ([]Source, error) {
	found, err := enumerate()
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	reconcileSourceIDs(m.sources, found)

	m.sources = make(map[string]Source, len(found))
	for _, source := range found {
		m.sources[source.ID] = source
	}
	return found, nil
}

// AudioProcessForSource resolves a capture source to the process whose audio
// should be recorded.
//
// The web client never supplies a PID or an HWND. It names a source by the
// opaque id this host issued, and the owner is resolved here from the last
// enumeration, so a page cannot aim process-loopback capture at an arbitrary
// application. The second result is false for a display, which has no owning
// process and therefore falls back to system audio.
func (m *Manager) AudioProcessForSource(sourceID string) (uint32, bool, error) {
	m.mu.Lock()
	source, known := m.sources[sourceID]
	m.mu.Unlock()
	if !known {
		return 0, false, errors.New("Refresh screen sources before sharing application audio")
	}
	if source.Kind == "monitor" {
		return 0, false, nil
	}
	if source.Kind != "window" {
		return 0, false, errors.New("The selected source cannot provide application audio")
	}
	processID, err := liveWindowProcess(source.Handle)
	if err != nil {
		return 0, false, err
	}
	return processID, true, nil
}

// StartOptions is what the page asks a capture for.
type StartOptions struct {
	SourceID      string       `json:"sourceId"`
	Encoder       string       `json:"encoder"`
	Width         uint32       `json:"width"`
	Height        uint32       `json:"height"`
	FPS           uint32       `json:"fps"`
	BitrateMbps   uint32       `json:"bitrateMbps"`
	Cursor        bool         `json:"cursor"`
	DisplayBorder bool         `json:"displayBorder"`
	H264Profile   h264.Profile `json:"h264Profile"`
}

// Start begins a capture and returns what it negotiated.
func (m *Manager) Start(ctx context.Context, options StartOptions) (Started, error) {
	if err := validateCaptureSettings(options.Width, options.Height, options.FPS, options.BitrateMbps); err != nil {
		return Started{}, err
	}
	profile := options.H264Profile
	if profile == "" {
		profile = h264.Baseline
	}
	if !profile.Valid() {
		return Started{}, fmt.Errorf("unknown H.264 profile %q", profile)
	}

	// Probed again at start so an installed runtime or an updated GPU driver is
	// reflected without restarting the app.
	capabilities := Probe(ctx)
	var encoderAvailable bool
	for _, encoder := range capabilities.Encoders {
		if encoder.ID == options.Encoder && encoder.Available {
			encoderAvailable = true
		}
	}
	if !encoderAvailable {
		return Started{}, errors.New("This encoder is unavailable")
	}

	m.mu.Lock()
	source, known := m.sources[options.SourceID]
	if m.active != nil && m.active.stopped.Load() {
		m.active = nil
	}
	busy := m.active != nil
	m.mu.Unlock()

	if !known {
		return Started{}, errors.New("Refresh sources and select a window or display")
	}
	if busy {
		return Started{}, errors.New("Stop the current native screen share first")
	}

	// The picker's dimensions may be stale or include invisible window borders.
	// The visible physical bounds are what both the encoder and any overlay
	// placement must agree on.
	if width, height, ok := visibleBounds(source); ok {
		source.Width, source.Height = width, height
	}

	// Resolution choices are bounds, not fixed canvases. Keeping the source's
	// aspect ratio stops FFmpeg baking letterbox or pillarbox bars into
	// portrait and unusually shaped application windows.
	maxWidth, maxHeight := options.Width, options.Height
	if maxWidth == 0 {
		maxWidth = 3840
	}
	if maxHeight == 0 {
		maxHeight = 2160
	}
	width, height := fitCaptureDimensions(source.Width, source.Height, maxWidth, maxHeight)
	if width < 16 || height < 16 {
		return Started{}, errors.New("The selected source has no capturable area")
	}

	sessionID, err := newSourceID()
	if err != nil {
		return Started{}, err
	}
	hub, err := nativertc.NewHub(sessionID, profile, width, height, options.FPS, options.BitrateMbps)
	if err != nil {
		return Started{}, err
	}
	path, err := ffmpegPath()
	if err != nil {
		hub.Close()
		return Started{}, err
	}

	level, err := h264.FFmpegLevel(profile, width, height, options.FPS, options.BitrateMbps)
	if err != nil {
		hub.Close()
		return Started{}, err
	}

	handleKind := "hwnd"
	if source.Kind == "monitor" {
		handleKind = "hmonitor"
	}
	filter := captureFilter(handleKind, source.Handle, options.Cursor, options.DisplayBorder, options.FPS, width, height)

	args := []string{
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", filter,
		"-an",
		"-r", strconv.FormatUint(uint64(options.FPS), 10),
	}
	args = append(args, encoderArgs(options.Encoder, options.FPS, options.BitrateMbps, profile)...)
	args = append(args, "-level:v", level)
	// An access unit delimiter before every picture is what lets the reader
	// below split the stream into whole frames.
	args = append(args, "-bsf:v", "h264_metadata=aud=insert", "-f", "h264", "pipe:1")

	captureCtx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(captureCtx, path, args...)
	hideWindow(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		hub.Close()
		return Started{}, fmt.Errorf("Encoder output unavailable: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		hub.Close()
		return Started{}, fmt.Errorf("Encoder diagnostics unavailable: %w", err)
	}
	if err := cmd.Start(); err != nil {
		cancel()
		hub.Close()
		return Started{}, fmt.Errorf("Could not start native capture: %w", err)
	}
	// Ownership is taken before the pipes are handed to goroutines, so a crash
	// between here and there cannot leave an encoder holding the display.
	if err := nativeprocess.Attach(cmd); err != nil {
		cancel()
		_ = cmd.Wait()
		hub.Close()
		return Started{}, err
	}

	info := Started{
		SessionID:   sessionID,
		Width:       width,
		Height:      height,
		FPS:         options.FPS,
		Encoder:     options.Encoder,
		H264Profile: profile,
		BitrateMbps: options.BitrateMbps,
	}
	m.mu.Lock()
	recorder := m.recorder
	m.mu.Unlock()

	running := &session{
		source:   source,
		info:     info,
		hub:      hub,
		cmd:      cmd,
		cancel:   cancel,
		done:     make(chan struct{}),
		recorder: recorder,
	}
	// Registered before any frame is pumped, so a recording started moments
	// later does not miss the keyframe it has to begin on.
	if recorder != nil {
		if err := recorder.RegisterSession(sessionID, options.FPS, path); err != nil {
			cancel()
			_ = cmd.Wait()
			hub.Close()
			return Started{}, err
		}
	}

	m.mu.Lock()
	if m.active != nil {
		m.mu.Unlock()
		cancel()
		_ = cmd.Wait()
		hub.Close()
		if recorder != nil {
			recorder.CaptureEnded(sessionID)
		}
		return Started{}, errors.New("Another native screen share started concurrently")
	}
	m.active = running
	m.mu.Unlock()

	go running.collectDiagnostics(stderr)
	go running.pump(stdout)

	return info, nil
}

// collectDiagnostics keeps a bounded tail of the encoder's stderr, which is
// what explains a capture that fails after it started.
func (s *session) collectDiagnostics(stderr io.ReadCloser) {
	defer func() { _ = stderr.Close() }()
	buffer := make([]byte, 4096)
	for {
		count, err := stderr.Read(buffer)
		if count > 0 {
			s.diagnosticsMu.Lock()
			remaining := maxDiagnosticsBytes - len(s.diagnostics)
			if remaining > 0 {
				s.diagnostics = append(s.diagnostics, buffer[:min(count, remaining)]...)
			}
			s.diagnosticsMu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// pump reads encoder output, splits it into access units, and hands each to the
// WebRTC hub.
func (s *session) pump(stdout io.ReadCloser) {
	defer close(s.done)
	defer func() { _ = stdout.Close() }()

	var parser accessUnits
	buffer := make([]byte, 64*1024)
	for {
		count, err := stdout.Read(buffer)
		if count > 0 {
			frames, parseErr := parser.push(buffer[:count])
			if parseErr != nil {
				s.stopped.Store(true)
				return
			}
			arrivedAt := time.Now()
			for _, frame := range frames {
				// The recorder gets the same bytes the viewers do. Recording is
				// a remux, not a second encode.
				if s.recorder != nil {
					s.recorder.FeedAccessUnit(s.info.SessionID, frame)
				}
				if writeErr := s.hub.WriteAccessUnit(frame, arrivedAt); writeErr != nil {
					s.stopped.Store(true)
					return
				}
			}
		}
		if err != nil {
			s.stopped.Store(true)
			return
		}
	}
}

// Diagnostics reports what the running capture is doing.
func (m *Manager) Diagnostics(sessionID string) (Started, string, error) {
	m.mu.Lock()
	active := m.active
	m.mu.Unlock()
	if active == nil || active.info.SessionID != sessionID {
		return Started{}, "", errors.New("The native share ended or changed")
	}
	active.diagnosticsMu.Lock()
	detail := string(active.diagnostics)
	active.diagnosticsMu.Unlock()
	return active.info, detail, nil
}

// Hub is the WebRTC sender for the running capture.
func (m *Manager) Hub(sessionID string) (*nativertc.Hub, error) {
	m.mu.Lock()
	active := m.active
	m.mu.Unlock()
	if active == nil || active.info.SessionID != sessionID || active.stopped.Load() {
		return nil, errors.New("The native share ended or changed")
	}
	return active.hub, nil
}

// Stop ends the named capture. Stopping one that already ended succeeds.
func (m *Manager) Stop(sessionID string) error {
	m.mu.Lock()
	active := m.active
	if active == nil || active.info.SessionID != sessionID {
		m.mu.Unlock()
		return nil
	}
	m.active = nil
	m.mu.Unlock()

	active.stopped.Store(true)
	active.cancel()
	<-active.done
	_ = active.cmd.Wait()
	active.hub.Close()
	if active.recorder != nil {
		active.recorder.CaptureEnded(active.info.SessionID)
	}
	return nil
}

// Close ends any running capture. The application calls this on shutdown so no
// encoder outlives the process that spawned it.
func (m *Manager) Close() {
	m.mu.Lock()
	active := m.active
	m.active = nil
	m.mu.Unlock()
	if active == nil {
		return
	}
	active.stopped.Store(true)
	active.cancel()
	<-active.done
	_ = active.cmd.Wait()
	active.hub.Close()
	if active.recorder != nil {
		active.recorder.CaptureEnded(active.info.SessionID)
	}
}
