// Package systemaudio captures what other applications are playing, without
// capturing the call itself.
//
// Windows process loopback is what makes this possible. Ordinary loopback
// records the whole endpoint, which in a call means recording the other
// participants and sending them back — an echo nobody can cancel. Process
// loopback either targets one application's process tree, or records everything
// except this application's, so the call is never part of what goes out.
package systemaudio

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	// Rate and Channels are what the capture is converted to. Fixing them here
	// means the page never has to resample.
	Rate     = 48_000
	Channels = 2
	// frameBytes is one stereo 32-bit float frame.
	frameBytes = 8

	// ringBytes is two seconds of audio. Enough to ride out a slow reader,
	// small enough that a stalled one cannot grow it.
	ringBytes = 192_000
	// readBytes is 100 ms, the most one read returns.
	readBytes = 38_400

	// MinimumWindowsBuild is where process loopback first appears.
	MinimumWindowsBuild = 20348

	// maxSessions bounds concurrent captures. Each is a WASAPI client and a
	// worker thread.
	maxSessions = 2

	startTimeout = 5 * time.Second
)

// Mode is what a session is capturing.
type Mode string

const (
	// ModeSystem is everything except this application's process tree, which is
	// what "share system audio" means during a call.
	ModeSystem Mode = "system"
	// ModeApplication is one application's process tree.
	ModeApplication Mode = "application"
	// ModeWholeSystem includes this application. Only used when the person has
	// explicitly turned call-audio exclusion off.
	ModeWholeSystem Mode = "whole-system"
)

// Capabilities reports whether process loopback works on this machine.
type Capabilities struct {
	Available           bool   `json:"available"`
	ApplicationAudio    bool   `json:"applicationAudio"`
	CallAudioControl    bool   `json:"callAudioControl"`
	Detail              string `json:"detail"`
	MinimumWindowsBuild uint32 `json:"minimumWindowsBuild"`
}

// Started describes a running capture.
type Started struct {
	SessionID  string `json:"sessionId"`
	SampleRate uint32 `json:"sampleRate"`
	Channels   uint16 `json:"channels"`
	Mode       Mode   `json:"mode"`
}

// target is the process-loopback selection.
type target struct {
	mode Mode
	// processID is the tree to include or exclude. Unused for ModeWholeSystem.
	processID uint32
}

// ring is the capture buffer.
//
// It drops the oldest audio rather than blocking the capture thread: WASAPI
// will not wait, and a late reader wants the newest audio anyway.
type ring struct {
	mu     sync.Mutex
	buffer []byte
}

func (r *ring) append(chunk []byte) {
	// Only whole frames, so a reader never sees a split sample.
	usable := len(chunk) / frameBytes * frameBytes
	if usable == 0 {
		return
	}
	chunk = chunk[:usable]

	r.mu.Lock()
	defer r.mu.Unlock()
	if overflow := len(r.buffer) + len(chunk) - ringBytes; overflow > 0 {
		drop := overflow / frameBytes * frameBytes
		if drop >= len(r.buffer) {
			r.buffer = r.buffer[:0]
		} else {
			r.buffer = append(r.buffer[:0], r.buffer[drop:]...)
		}
	}
	r.buffer = append(r.buffer, chunk...)
}

// take returns up to 100 ms, discarding anything older first.
//
// A reader that fell behind gets the newest audio rather than replaying a
// backlog, because stale audio played late is worse than a gap.
func (r *ring) take() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()

	if stale := (len(r.buffer) - readBytes) / frameBytes * frameBytes; stale > 0 {
		r.buffer = append(r.buffer[:0], r.buffer[stale:]...)
	}
	size := min(len(r.buffer), readBytes) / frameBytes * frameBytes
	if size == 0 {
		return nil
	}
	chunk := append([]byte(nil), r.buffer[:size]...)
	r.buffer = append(r.buffer[:0], r.buffer[size:]...)
	return chunk
}

// session is one running capture.
type session struct {
	stop chan struct{}
	once sync.Once
	done chan struct{}
	ring *ring

	mu      sync.Mutex
	failure error
}

func (s *session) halt() { s.once.Do(func() { close(s.stop) }) }

func (s *session) fail(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failure == nil {
		s.failure = err
	}
}

func (s *session) err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failure
}

// SourceResolver resolves an opaque capture-source id to the process whose
// audio should be captured.
//
// It is a function so this package never sees a source catalogue: the page
// names a source, the screen capture manager owns what that means, and nothing
// here can be pointed at an arbitrary process.
type SourceResolver func(sourceID string) (uint32, bool, error)

// Manager owns the running captures.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*session
	// selfProcess is the process tree excluded from "system" capture: this
	// application and everything it spawned, including the webview.
	selfProcess func() (uint32, error)
}

// NewManager returns a manager with no capture running.
func NewManager() *Manager {
	return &Manager{
		sessions:    map[string]*session{},
		selfProcess: ownProcessTree,
	}
}

// Describe reports what this machine can do.
func Describe() Capabilities {
	build, known := windowsBuild()
	available := known && build >= MinimumWindowsBuild

	detail := "Process-loopback audio is unavailable"
	switch {
	case available:
		detail = fmt.Sprintf(
			"Process-loopback application and call-audio exclusion modes are available (Windows build %d); no audio was captured",
			build)
	case known:
		detail = fmt.Sprintf("Windows build %d is older than required build %d", build, MinimumWindowsBuild)
	}
	return Capabilities{
		Available:           available,
		ApplicationAudio:    available,
		CallAudioControl:    available,
		Detail:              detail,
		MinimumWindowsBuild: MinimumWindowsBuild,
	}
}

// StartOptions is what the page asks a capture for.
type StartOptions struct {
	// SourceID names a capture source whose application audio to record. Empty
	// captures the system instead.
	SourceID string `json:"sourceId"`
	// ExcludeCallAudio defaults to true. Turning it off records this
	// application too, which in a call means recording the other participants.
	ExcludeCallAudio *bool `json:"excludeCallAudio"`
}

func newSessionID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("Could not allocate a system audio session")
	}
	return hex.EncodeToString(raw), nil
}

// resolveTarget decides what the capture records.
func (m *Manager) resolveTarget(options StartOptions, resolve SourceResolver) (target, error) {
	excludeCall := options.ExcludeCallAudio == nil || *options.ExcludeCallAudio

	if options.SourceID != "" {
		if resolve == nil {
			return target{}, errors.New("Refresh screen sources before sharing application audio")
		}
		processID, isWindow, err := resolve(options.SourceID)
		if err != nil {
			return target{}, err
		}
		if isWindow {
			return target{mode: ModeApplication, processID: processID}, nil
		}
		// A display has no owning process, so it falls through to system audio.
	}

	if !excludeCall {
		return target{mode: ModeWholeSystem}, nil
	}
	self, err := m.selfProcess()
	if err != nil {
		return target{}, err
	}
	return target{mode: ModeSystem, processID: self}, nil
}

// Start begins a capture.
func (m *Manager) Start(options StartOptions, resolve SourceResolver) (Started, error) {
	build, known := windowsBuild()
	if !known || build < MinimumWindowsBuild {
		return Started{}, fmt.Errorf(
			"Native application and system audio require Windows build %d or newer", MinimumWindowsBuild)
	}

	selected, err := m.resolveTarget(options, resolve)
	if err != nil {
		return Started{}, err
	}

	m.mu.Lock()
	if len(m.sessions) >= maxSessions {
		m.mu.Unlock()
		return Started{}, errors.New("Too many system audio sessions")
	}
	m.mu.Unlock()

	id, err := newSessionID()
	if err != nil {
		return Started{}, err
	}
	current := &session{
		stop: make(chan struct{}),
		done: make(chan struct{}),
		ring: &ring{buffer: make([]byte, 0, ringBytes)},
	}

	ready := make(chan error, 1)
	go func() {
		defer close(current.done)
		if err := capture(current.stop, current.ring, ready, selected); err != nil {
			current.fail(err)
			select {
			case ready <- err:
			default:
			}
		}
	}()

	select {
	case err := <-ready:
		if err != nil {
			current.halt()
			<-current.done
			return Started{}, err
		}
	case <-time.After(startTimeout):
		current.halt()
		<-current.done
		return Started{}, errors.New("System audio startup timed out")
	}

	m.mu.Lock()
	if len(m.sessions) >= maxSessions {
		m.mu.Unlock()
		current.halt()
		<-current.done
		return Started{}, errors.New("Too many system audio sessions")
	}
	m.sessions[id] = current
	m.mu.Unlock()

	return Started{
		SessionID:  id,
		SampleRate: Rate,
		Channels:   Channels,
		Mode:       selected.mode,
	}, nil
}

// Read returns the next chunk of captured audio.
func (m *Manager) Read(sessionID string) ([]byte, error) {
	m.mu.Lock()
	current, ok := m.sessions[sessionID]
	m.mu.Unlock()
	if !ok {
		return nil, errors.New("System audio capture is no longer active")
	}
	if err := current.err(); err != nil {
		return nil, fmt.Errorf("Native system audio stopped: %w", err)
	}
	select {
	case <-current.done:
		return nil, errors.New("Native system audio stopped unexpectedly")
	default:
	}
	return current.ring.take(), nil
}

// Stop ends a capture. Stopping one that already ended succeeds.
func (m *Manager) Stop(sessionID string) error {
	m.mu.Lock()
	current, ok := m.sessions[sessionID]
	delete(m.sessions, sessionID)
	m.mu.Unlock()
	if !ok {
		return nil
	}
	current.halt()
	<-current.done
	return nil
}

// Close ends every capture. The application calls this on shutdown so no
// WASAPI client outlives the process.
func (m *Manager) Close() {
	m.mu.Lock()
	sessions := make([]*session, 0, len(m.sessions))
	for _, current := range m.sessions {
		sessions = append(sessions, current)
	}
	m.sessions = map[string]*session{}
	m.mu.Unlock()

	for _, current := range sessions {
		current.halt()
		<-current.done
	}
}
