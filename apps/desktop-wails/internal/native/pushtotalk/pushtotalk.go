// Package pushtotalk provides background push-to-talk: a key or mouse button
// that opens the microphone while the application does not have focus.
//
// The hook this installs is deliberately narrow. It never captures characters,
// never records what is typed, and never suppresses an input, so a game or any
// other foreground application keeps receiving the same events it would
// otherwise. It observes one binding and reports whether that binding is down.
//
// A session is leased. The page renews it while a call is live, and the worker
// shuts itself down when the lease lapses, so a crashed or navigated-away page
// cannot leave a global hook installed.
package pushtotalk

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Lease is how long a session survives without a heartbeat.
const Lease = 5 * time.Second

// lease is the value actually enforced. It exists so the lease-expiry
// behaviour can be tested without a five-second wait; nothing but a test
// changes it.
var lease = Lease

// Event is the name the page listens on for snapshot changes.
const Event = "bc-global-push-to-talk"

// BindingKind distinguishes the two things that can be bound.
type BindingKind string

const (
	KindKeyboard BindingKind = "keyboard"
	KindMouse    BindingKind = "mouse"
)

// Binding is what the page asks to watch.
type Binding struct {
	Kind BindingKind `json:"kind"`
	// Code is a physical DOM code such as "KeyV", for KindKeyboard.
	Code string `json:"code,omitempty"`
	// Button is 0-4, for KindMouse.
	Button uint8 `json:"button,omitempty"`
}

// input is a binding resolved to what the operating system reports.
type input struct {
	keyboard bool
	scan     uint32
	extended bool
	button   uint8
}

// Snapshot is the state the page renders from.
type Snapshot struct {
	SessionID string `json:"sessionId"`
	Sequence  uint32 `json:"sequence"`
	Pressed   bool   `json:"pressed"`
	Healthy   bool   `json:"healthy"`
	Focused   bool   `json:"focused"`
}

// Capabilities reports whether this platform has background push-to-talk.
type Capabilities struct {
	Available bool   `json:"available"`
	Detail    string `json:"detail"`
}

var (
	// ErrUnsupportedKey names a key with no stable physical scan code here.
	ErrUnsupportedKey = errors.New("This key is not supported globally. Choose a letter, modifier, F1–F12, navigation key, or mouse button.")
	// ErrUnsupportedButton names a mouse button outside the bindable range.
	ErrUnsupportedButton = errors.New("Choose mouse button 1 through 5")
	// ErrExpired reports a session that is no longer the current one.
	ErrExpired = errors.New("Global input session expired")
)

// scanCode is the physical DOM code to Windows scan code map. Physical codes
// are used rather than key values so a binding survives a layout change: the
// same physical key opens the microphone on QWERTY and AZERTY alike.
//
// The extended flag is what separates keys that share a scan code — the two
// Controls, Enter and NumpadEnter, the arrows and the numpad.
var scanCode = map[string]struct {
	scan     uint32
	extended bool
}{
	"Digit1": {0x02, false}, "Digit2": {0x03, false}, "Digit3": {0x04, false},
	"Digit4": {0x05, false}, "Digit5": {0x06, false}, "Digit6": {0x07, false},
	"Digit7": {0x08, false}, "Digit8": {0x09, false}, "Digit9": {0x0a, false},
	"Digit0": {0x0b, false}, "Minus": {0x0c, false}, "Equal": {0x0d, false},
	"Backspace": {0x0e, false}, "KeyQ": {0x10, false}, "KeyW": {0x11, false},
	"KeyE": {0x12, false}, "KeyR": {0x13, false}, "KeyT": {0x14, false},
	"KeyY": {0x15, false}, "KeyU": {0x16, false}, "KeyI": {0x17, false},
	"KeyO": {0x18, false}, "KeyP": {0x19, false}, "BracketLeft": {0x1a, false},
	"BracketRight": {0x1b, false}, "Enter": {0x1c, false}, "ControlLeft": {0x1d, false},
	"KeyA": {0x1e, false}, "KeyS": {0x1f, false}, "KeyD": {0x20, false},
	"KeyF": {0x21, false}, "KeyG": {0x22, false}, "KeyH": {0x23, false},
	"KeyJ": {0x24, false}, "KeyK": {0x25, false}, "KeyL": {0x26, false},
	"Semicolon": {0x27, false}, "Quote": {0x28, false}, "Backquote": {0x29, false},
	"ShiftLeft": {0x2a, false}, "Backslash": {0x2b, false}, "KeyZ": {0x2c, false},
	"KeyX": {0x2d, false}, "KeyC": {0x2e, false}, "KeyV": {0x2f, false},
	"KeyB": {0x30, false}, "KeyN": {0x31, false}, "KeyM": {0x32, false},
	"Comma": {0x33, false}, "Period": {0x34, false}, "Slash": {0x35, false},
	"ShiftRight": {0x36, false}, "NumpadMultiply": {0x37, false}, "AltLeft": {0x38, false},
	"Space": {0x39, false}, "CapsLock": {0x3a, false},
	"F1": {0x3b, false}, "F2": {0x3c, false}, "F3": {0x3d, false},
	"F4": {0x3e, false}, "F5": {0x3f, false}, "F6": {0x40, false},
	"F7": {0x41, false}, "F8": {0x42, false}, "F9": {0x43, false},
	"F10": {0x44, false}, "NumLock": {0x45, true}, "ScrollLock": {0x46, false},
	"Numpad7": {0x47, false}, "Numpad8": {0x48, false}, "Numpad9": {0x49, false},
	"NumpadSubtract": {0x4a, false}, "Numpad4": {0x4b, false}, "Numpad5": {0x4c, false},
	"Numpad6": {0x4d, false}, "NumpadAdd": {0x4e, false}, "Numpad1": {0x4f, false},
	"Numpad2": {0x50, false}, "Numpad3": {0x51, false}, "Numpad0": {0x52, false},
	"NumpadDecimal": {0x53, false}, "IntlBackslash": {0x56, false},
	"F11": {0x57, false}, "F12": {0x58, false},
	"ControlRight": {0x1d, true}, "AltRight": {0x38, true},
	"NumpadEnter": {0x1c, true}, "NumpadDivide": {0x35, true},
	"Home": {0x47, true}, "ArrowUp": {0x48, true}, "PageUp": {0x49, true},
	"ArrowLeft": {0x4b, true}, "ArrowRight": {0x4d, true}, "End": {0x4f, true},
	"ArrowDown": {0x50, true}, "PageDown": {0x51, true}, "Insert": {0x52, true},
	"Delete": {0x53, true}, "ContextMenu": {0x5d, true},
}

// resolve turns a binding into the physical input the hook will watch.
func (b Binding) resolve() (input, error) {
	switch b.Kind {
	case KindMouse:
		if b.Button > 4 {
			return input{}, ErrUnsupportedButton
		}
		return input{button: b.Button}, nil
	case KindKeyboard:
		code, ok := scanCode[b.Code]
		if !ok {
			return input{}, ErrUnsupportedKey
		}
		return input{keyboard: true, scan: code.scan, extended: code.extended}, nil
	default:
		return input{}, ErrUnsupportedButton
	}
}

// inputState debounces a binding into open/closed transitions.
//
// A binding already held when the session starts must not open the microphone.
// Arming only on a release is what stops a key that was down at join time — or
// an auto-repeat — from transmitting until the person deliberately presses it.
type inputState struct {
	armed    bool
	pressed  bool
	sequence uint32
}

func newInputState(alreadyDown bool) *inputState {
	return &inputState{armed: !alreadyDown}
}

// update records the binding's physical state and reports whether the derived
// pressed state changed.
func (s *inputState) update(down bool) bool {
	if !down {
		s.armed = true
	}
	pressed := s.armed && down
	if pressed == s.pressed {
		return false
	}
	s.pressed = pressed
	s.sequence++
	return true
}

// Options are the host callbacks a session needs. Keeping them as functions is
// what lets this package stay free of any window toolkit.
type Options struct {
	// Emit publishes a snapshot to the page.
	Emit func(Snapshot)
	// Focused reports whether the app window currently has focus, so the page
	// can tell a background hold from a foreground one.
	Focused func() bool
	// Trusted reports whether the app window is still showing the app. A
	// session ends when it stops being true.
	Trusted func() bool
}

func (o Options) focused() bool {
	if o.Focused == nil {
		return true
	}
	return o.Focused()
}

func (o Options) trusted() bool {
	if o.Trusted == nil {
		return true
	}
	return o.Trusted()
}

func (o Options) emit(snapshot Snapshot) {
	if o.Emit != nil && o.trusted() {
		o.Emit(snapshot)
	}
}

// shared is the snapshot plus its lease, written by the worker and read by the
// heartbeat.
type shared struct {
	mu        sync.Mutex
	snapshot  Snapshot
	heartbeat time.Time
}

func (s *shared) touch() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.heartbeat = time.Now()
	return s.snapshot
}

func (s *shared) expired() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Since(s.heartbeat) > lease
}

func (s *shared) publish(pressed bool, sequence uint32, healthy, focused bool) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot.Pressed = pressed
	s.snapshot.Sequence = sequence
	s.snapshot.Healthy = healthy
	s.snapshot.Focused = focused
	return s.snapshot
}

type session struct {
	id     string
	shared *shared
	worker *worker
}

// Manager owns the single global input session this application may hold.
type Manager struct {
	// lifecycle serialises start and stop so two calls cannot both believe
	// they own the hook.
	lifecycle sync.Mutex
	mu        sync.Mutex
	current   *session
}

// NewManager returns a manager holding no session.
func NewManager() *Manager { return &Manager{} }

// Describe reports whether background push-to-talk works on this platform.
func Describe() Capabilities {
	if supported {
		return Capabilities{
			Available: true,
			Detail:    "Global keyboard and mouse push-to-talk is available during calls on Windows.",
		}
	}
	return Capabilities{
		Detail: "Global push-to-talk is not available on this platform; use the focused-window shortcut.",
	}
}

// Start replaces any current session with one watching binding.
func (m *Manager) Start(binding Binding, options Options) (Snapshot, error) {
	resolved, err := binding.resolve()
	if err != nil {
		return Snapshot{}, err
	}

	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	m.stopCurrent()

	id, err := newSessionID()
	if err != nil {
		return Snapshot{}, err
	}
	state := &shared{
		snapshot:  Snapshot{SessionID: id, Healthy: true, Focused: options.focused()},
		heartbeat: time.Now(),
	}
	started, err := startWorker(resolved, state, options)
	if err != nil {
		return Snapshot{}, err
	}

	m.mu.Lock()
	m.current = &session{id: id, shared: state, worker: started}
	m.mu.Unlock()

	state.mu.Lock()
	snapshot := state.snapshot
	state.mu.Unlock()
	return snapshot, nil
}

// Heartbeat renews the lease and returns the current snapshot.
func (m *Manager) Heartbeat(sessionID string) (Snapshot, error) {
	m.mu.Lock()
	current := m.current
	m.mu.Unlock()
	if current == nil || current.id != sessionID {
		return Snapshot{}, ErrExpired
	}
	return current.shared.touch(), nil
}

// Stop ends the named session. Stopping one that is already gone succeeds:
// the caller's goal is that it not be running.
func (m *Manager) Stop(sessionID string) error {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()

	m.mu.Lock()
	current := m.current
	if current == nil || current.id != sessionID {
		m.mu.Unlock()
		return nil
	}
	m.current = nil
	m.mu.Unlock()

	current.worker.stop()
	return nil
}

// Close ends any session. It is what the application calls on shutdown, so a
// hook never outlives the process that installed it.
func (m *Manager) Close() {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	m.stopCurrent()
}

func (m *Manager) stopCurrent() {
	m.mu.Lock()
	current := m.current
	m.current = nil
	m.mu.Unlock()
	if current != nil {
		current.worker.stop()
	}
}

func newSessionID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("Could not allocate global input session: %w", err)
	}
	return hex.EncodeToString(raw), nil
}
