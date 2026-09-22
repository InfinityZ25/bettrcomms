//go:build windows

package pushtotalk

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// shortLease makes the lease-expiry paths testable without a five-second wait.
func shortLease(t *testing.T, d time.Duration) {
	t.Helper()
	previous := lease
	lease = d
	t.Cleanup(func() { lease = previous })
}

type recorder struct {
	mu        sync.Mutex
	snapshots []Snapshot
}

func (r *recorder) emit(snapshot Snapshot) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.snapshots = append(r.snapshots, snapshot)
}

func (r *recorder) all() []Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Snapshot(nil), r.snapshots...)
}

// The hook installs against the real Windows API. This is the port's core
// claim: SetWindowsHookEx succeeds on a dedicated, OS-locked thread and the
// worker's message loop runs there.
func TestStartInstallsARealHook(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Close)

	// ScrollLock is bound rather than a letter so a stray physical press
	// during the test cannot type into whatever has focus.
	snapshot, err := manager.Start(Binding{Kind: KindKeyboard, Code: "ScrollLock"}, Options{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if snapshot.SessionID == "" {
		t.Error("the session has no id")
	}
	if !snapshot.Healthy {
		t.Error("a freshly started session is not healthy")
	}
	if snapshot.Pressed {
		t.Error("a freshly started session reports the binding pressed")
	}

	renewed, err := manager.Heartbeat(snapshot.SessionID)
	if err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if renewed.SessionID != snapshot.SessionID {
		t.Errorf("heartbeat returned session %q, want %q", renewed.SessionID, snapshot.SessionID)
	}
}

// A mouse binding installs the other hook type.
func TestStartInstallsAMouseHook(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Close)

	if _, err := manager.Start(Binding{Kind: KindMouse, Button: 3}, Options{}); err != nil {
		t.Fatalf("Start: %v", err)
	}
}

// The lease is what keeps a crashed or navigated-away page from leaving a
// global hook installed. When it lapses the worker exits on its own and
// reports the binding released, so the microphone cannot stay open.
func TestTheWorkerShutsItselfDownWhenTheLeaseLapses(t *testing.T) {
	shortLease(t, 150*time.Millisecond)

	manager := NewManager()
	t.Cleanup(manager.Close)
	seen := &recorder{}

	snapshot, err := manager.Start(
		Binding{Kind: KindKeyboard, Code: "ScrollLock"},
		Options{Emit: seen.emit},
	)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// The watchdog ticks every 250ms, so give it a few ticks to notice.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		final := seen.all()
		if len(final) > 0 && !final[len(final)-1].Healthy {
			if final[len(final)-1].Pressed {
				t.Error("the closing snapshot still reports the binding pressed")
			}
			if final[len(final)-1].SessionID != snapshot.SessionID {
				t.Error("the closing snapshot belongs to another session")
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the worker did not report itself unhealthy after the lease lapsed")
}

// A session ends when the window stops showing the app, so a hook cannot
// outlive the origin that asked for it.
//
// The worker's exit is what is asserted, not an event: an untrusted window is
// exactly the one this must not publish snapshots to, so nothing is emitted on
// the way out.
func TestTheWorkerShutsDownWhenTheWindowStopsBeingTrusted(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Close)

	untrusted := make(chan struct{})
	seen := &recorder{}

	if _, err := manager.Start(Binding{Kind: KindKeyboard, Code: "ScrollLock"}, Options{
		Emit: seen.emit,
		Trusted: func() bool {
			select {
			case <-untrusted:
				return false
			default:
				return true
			}
		},
	}); err != nil {
		t.Fatalf("Start: %v", err)
	}

	manager.mu.Lock()
	done := manager.current.worker.done
	manager.mu.Unlock()

	close(untrusted)

	// The watchdog ticks every 250ms; a few ticks is generous.
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the worker kept its hook after the window stopped being trusted")
	}
	// Whether the closing snapshot is emitted depends on which condition ended
	// the loop, so that is asserted directly against Options.emit instead. What
	// matters here is that the hook is gone.
	_ = seen
}

// Starting again replaces the previous session rather than stacking a second
// hook, and the old session's heartbeat stops being accepted.
func TestStartReplacesThePreviousSession(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Close)

	first, err := manager.Start(Binding{Kind: KindKeyboard, Code: "ScrollLock"}, Options{})
	if err != nil {
		t.Fatalf("first Start: %v", err)
	}
	second, err := manager.Start(Binding{Kind: KindMouse, Button: 3}, Options{})
	if err != nil {
		t.Fatalf("second Start: %v", err)
	}
	if first.SessionID == second.SessionID {
		t.Fatal("the replacement reused the previous session id")
	}
	if _, err := manager.Heartbeat(first.SessionID); !errors.Is(err, ErrExpired) {
		t.Errorf("the replaced session still accepts a heartbeat: %v", err)
	}
	if _, err := manager.Heartbeat(second.SessionID); err != nil {
		t.Errorf("the current session rejects its heartbeat: %v", err)
	}
}

// Stop tears the hook down and its worker goroutine with it.
func TestStopEndsTheSession(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Close)

	snapshot, err := manager.Start(Binding{Kind: KindKeyboard, Code: "ScrollLock"}, Options{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := manager.Stop(snapshot.SessionID); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := manager.Heartbeat(snapshot.SessionID); !errors.Is(err, ErrExpired) {
		t.Errorf("a stopped session still accepts a heartbeat: %v", err)
	}
}

// virtualKey maps a scan code back to a virtual key, which is what the
// watchdog polls. A wrong mapping would make the watchdog reconcile against
// the wrong key and close the microphone mid-hold.
func TestVirtualKeyMapsTheBoundPhysicalKey(t *testing.T) {
	space, err := Binding{Kind: KindKeyboard, Code: "Space"}.resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got := virtualKey(space); got != 0x20 {
		t.Errorf("Space maps to %#x, want VK_SPACE (0x20)", got)
	}

	left, err := Binding{Kind: KindKeyboard, Code: "ControlLeft"}.resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	right, err := Binding{Kind: KindKeyboard, Code: "ControlRight"}.resolve()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	// VK_LCONTROL is 0xA2 and VK_RCONTROL 0xA3. The extended flag is the only
	// thing separating them, so a lost flag shows up here.
	if virtualKey(left) == virtualKey(right) {
		t.Errorf("both Controls mapped to %#x", virtualKey(left))
	}

	for button, want := range map[uint8]uint32{0: 1, 1: 4, 2: 2, 3: 5, 4: 6} {
		if got := virtualKey(input{button: button}); got != want {
			t.Errorf("mouse button %d maps to %d, want %d", button, got, want)
		}
	}
}
