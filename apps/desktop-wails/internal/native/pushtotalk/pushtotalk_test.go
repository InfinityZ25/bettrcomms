package pushtotalk

import (
	"errors"
	"testing"
)

// A binding already held when the session starts must not transmit, and an
// auto-repeat must not produce a second opening. Both are what stop a key that
// happened to be down at join time from opening the microphone.
func TestInitialHoldAndRepeatNeverOpenUntilReleased(t *testing.T) {
	state := newInputState(true)

	if state.update(true) || state.pressed {
		t.Fatal("a binding held at start opened the microphone")
	}
	if state.update(false) {
		t.Fatal("the arming release reported a change")
	}
	if !state.update(true) {
		t.Fatal("the first deliberate press did not open")
	}
	if state.update(true) {
		t.Fatal("an auto-repeat produced a second transition")
	}
	if state.sequence != 1 {
		t.Errorf("sequence = %d, want 1", state.sequence)
	}
	if !state.update(false) || state.pressed {
		t.Fatal("the release did not close")
	}
	if state.sequence != 2 {
		t.Errorf("sequence = %d, want 2", state.sequence)
	}
}

// A binding not held at start opens on its first press, with no arming release.
func TestAFreeBindingOpensImmediately(t *testing.T) {
	state := newInputState(false)
	if !state.update(true) || !state.pressed {
		t.Error("the first press did not open")
	}
}

// Physical codes are what make a binding survive a keyboard-layout change, and
// the extended flag is what separates keys sharing a scan code.
func TestPhysicalKeysDistinguishExtendedAndNumpad(t *testing.T) {
	resolve := func(code string) input {
		t.Helper()
		got, err := Binding{Kind: KindKeyboard, Code: code}.resolve()
		if err != nil {
			t.Fatalf("resolve %s: %v", code, err)
		}
		return got
	}
	for _, pair := range [][2]string{
		{"ControlLeft", "ControlRight"},
		{"Enter", "NumpadEnter"},
		{"ArrowUp", "Numpad8"},
		{"AltLeft", "AltRight"},
		{"Slash", "NumpadDivide"},
	} {
		if resolve(pair[0]) == resolve(pair[1]) {
			t.Errorf("%s and %s resolved to the same physical input", pair[0], pair[1])
		}
	}
	if got := resolve("KeyV"); got != (input{keyboard: true, scan: 0x2f}) {
		t.Errorf("KeyV = %+v, want scan 0x2f", got)
	}
}

func TestUnsupportedKeysAreRejected(t *testing.T) {
	// These are reserved by the system or have no stable physical code, so
	// binding them would either fail silently or fight the desktop.
	for _, code := range []string{"Escape", "Tab", "MetaLeft", "Unidentified", ""} {
		if _, err := (Binding{Kind: KindKeyboard, Code: code}).resolve(); !errors.Is(err, ErrUnsupportedKey) {
			t.Errorf("%q: err = %v, want ErrUnsupportedKey", code, err)
		}
	}
}

func TestMouseButtonsResolveWithinRange(t *testing.T) {
	for button := uint8(0); button <= 4; button++ {
		got, err := Binding{Kind: KindMouse, Button: button}.resolve()
		if err != nil {
			t.Fatalf("button %d: %v", button, err)
		}
		if got != (input{button: button}) {
			t.Errorf("button %d = %+v", button, got)
		}
	}
	if _, err := (Binding{Kind: KindMouse, Button: 5}).resolve(); !errors.Is(err, ErrUnsupportedButton) {
		t.Errorf("button 5 was accepted")
	}
}

func TestAnUnknownBindingKindIsRejected(t *testing.T) {
	if _, err := (Binding{Kind: "gamepad"}).resolve(); err == nil {
		t.Error("an unknown binding kind was accepted")
	}
}

func TestSessionIDsAreUniqueAndOpaque(t *testing.T) {
	first, err := newSessionID()
	if err != nil {
		t.Fatalf("newSessionID: %v", err)
	}
	second, err := newSessionID()
	if err != nil {
		t.Fatalf("newSessionID: %v", err)
	}
	if first == second {
		t.Error("two sessions shared an id")
	}
	if len(first) != 32 {
		t.Errorf("id is %d characters, want 32 hex", len(first))
	}
}

func TestDescribeMatchesThePlatform(t *testing.T) {
	got := Describe()
	if got.Available != supported {
		t.Errorf("Available = %v, want %v", got.Available, supported)
	}
	if got.Detail == "" {
		t.Error("Describe carries no explanation")
	}
}

// A heartbeat for a session that is not the current one must fail rather than
// renewing whatever happens to be running.
func TestHeartbeatRejectsAnUnknownSession(t *testing.T) {
	manager := NewManager()
	if _, err := manager.Heartbeat("never-started"); !errors.Is(err, ErrExpired) {
		t.Errorf("err = %v, want ErrExpired", err)
	}
}

// Stopping a session that is already gone is not an error: the caller's goal is
// that it not be running, and it is not.
func TestStopIsIdempotent(t *testing.T) {
	manager := NewManager()
	if err := manager.Stop("never-started"); err != nil {
		t.Errorf("Stop: %v", err)
	}
	manager.Close()
}

func TestStartRejectsABadBindingBeforeTouchingTheHook(t *testing.T) {
	manager := NewManager()
	if _, err := manager.Start(Binding{Kind: KindKeyboard, Code: "Escape"}, Options{}); !errors.Is(err, ErrUnsupportedKey) {
		t.Errorf("err = %v, want ErrUnsupportedKey", err)
	}
	if manager.current != nil {
		t.Error("a rejected binding still installed a session")
	}
}

// A window that has stopped showing the app must never be sent a snapshot: it
// is exactly the case where the page on the other end is not the one that
// asked for the hook.
func TestSnapshotsAreNeverEmittedToAnUntrustedWindow(t *testing.T) {
	var delivered []Snapshot
	options := Options{
		Emit:    func(snapshot Snapshot) { delivered = append(delivered, snapshot) },
		Trusted: func() bool { return false },
	}
	options.emit(Snapshot{SessionID: "session"})

	if len(delivered) != 0 {
		t.Errorf("emitted to an untrusted window: %+v", delivered)
	}

	options.Trusted = func() bool { return true }
	options.emit(Snapshot{SessionID: "session"})
	if len(delivered) != 1 {
		t.Errorf("a trusted window received %d snapshots, want 1", len(delivered))
	}
}

// Absent callbacks must not panic: a host that supplies none still gets a
// working session, just without focus reporting.
func TestOptionsTolerateMissingCallbacks(t *testing.T) {
	var options Options
	options.emit(Snapshot{})
	if !options.focused() {
		t.Error("focus defaults to false without a callback")
	}
	if !options.trusted() {
		t.Error("trust defaults to false without a callback")
	}
}
