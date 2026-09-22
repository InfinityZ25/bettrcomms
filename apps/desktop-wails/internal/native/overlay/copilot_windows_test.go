//go:build windows

package overlay

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"
)

// signalWindow is the real HWND behind one signal, so the assertions below test
// the window Windows actually has rather than the manager's own bookkeeping.
func signalWindow(t *testing.T, manager *CopilotManager, markID string) uintptr {
	t.Helper()
	manager.mu.Lock()
	defer manager.mu.Unlock()
	item, ok := manager.items[markID]
	if !ok {
		t.Fatalf("no signal is on screen for %q", markID)
	}
	window, ok := item.surface.(*windowSurface)
	if !ok {
		t.Fatal("the signal is not backed by a layered window")
	}
	return window.hwnd
}

// A display at a known place, so the expected desktop coordinates are arithmetic
// rather than a guess about this machine's monitors.
func fixedGeometry() Geometry {
	return Geometry{Left: 0, Top: 0, Width: 1920, Height: 1080, EncodedWidth: 1280, EncodedHeight: 720}
}

func fixedCopilotManager(t *testing.T) *CopilotManager {
	t.Helper()
	manager := NewCopilotManager(func(string, bool) (Geometry, error) { return fixedGeometry(), nil })
	t.Cleanup(manager.Shutdown)
	return manager
}

// This is the acceptance test: a signal becomes a real window, at the place the
// point maps to, excluded from capture, and visible.
func TestASignalBecomesARealWindowWhereThePointMaps(t *testing.T) {
	manager := fixedCopilotManager(t)

	frame := CopilotFrame{
		MarkID: "mark-1", SessionID: "session-1", Corner: CopilotPoint,
		Width: 180, Height: 180, X: 0.25, Y: 0.75,
	}
	if err := manager.Frame(frame, testFrame(frame.Width, frame.Height)); err != nil {
		t.Fatalf("Frame: %v", err)
	}

	hwnd := signalWindow(t, manager, "mark-1")
	if alive, _, _ := procIsWindow.Call(hwnd); alive == 0 {
		t.Fatal("the signal has no window")
	}
	if visible, _, _ := procIsWindowVisible.Call(hwnd); visible == 0 {
		t.Error("a signal over the shared window is not visible")
	}

	// A share cannot be allowed to contain the signals drawn over it.
	var affinity uint32
	if ok, _, err := procGetWindowDisplayAffinity.Call(hwnd, uintptr(unsafe.Pointer(&affinity))); ok == 0 {
		t.Fatalf("GetWindowDisplayAffinity: %v", err)
	}
	if affinity != wdaExcludeFromCapture {
		t.Errorf("display affinity is 0x%x, want 0x%x (excluded from capture)", affinity, wdaExcludeFromCapture)
	}

	wantLeft, wantTop := copilotPosition(fixedGeometry(), frame.Width, frame.Height, frame.X, frame.Y, frame.Corner)
	bounds := windowBounds(t, hwnd)
	if bounds.Left != wantLeft || bounds.Top != wantTop {
		t.Errorf("the signal is at (%d, %d), want (%d, %d)", bounds.Left, bounds.Top, wantLeft, wantTop)
	}
	width, height := uint32(bounds.Right-bounds.Left), uint32(bounds.Bottom-bounds.Top)
	if width != frame.Width || height != frame.Height {
		t.Errorf("the signal is %dx%d, want %dx%d", width, height, frame.Width, frame.Height)
	}

	manager.Clear()
	if manager.Count() != 0 {
		t.Errorf("%d signals survived Clear", manager.Count())
	}
	if alive, _, _ := procIsWindow.Call(hwnd); alive != 0 {
		t.Error("the signal window outlived Clear")
	}
}

// Refreshing a signal must reuse its window. A new window per refresh would
// flicker three times a second.
func TestRefreshingASignalReusesItsWindow(t *testing.T) {
	manager := fixedCopilotManager(t)

	frame := CopilotFrame{
		MarkID: "mark-1", SessionID: "session-1", Corner: CopilotPoint,
		Width: 120, Height: 120, X: 0.1, Y: 0.1,
	}
	if err := manager.Frame(frame, testFrame(frame.Width, frame.Height)); err != nil {
		t.Fatalf("Frame: %v", err)
	}
	first := signalWindow(t, manager, "mark-1")

	frame.X, frame.Y = 0.6, 0.4
	if err := manager.Frame(frame, testFrame(frame.Width, frame.Height)); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if second := signalWindow(t, manager, "mark-1"); second != first {
		t.Error("the refresh created a second window")
	}

	wantLeft, wantTop := copilotPosition(fixedGeometry(), frame.Width, frame.Height, frame.X, frame.Y, frame.Corner)
	bounds := windowBounds(t, first)
	if bounds.Left != wantLeft || bounds.Top != wantTop {
		t.Errorf("the signal did not move: it is at (%d, %d), want (%d, %d)",
			bounds.Left, bounds.Top, wantLeft, wantTop)
	}
}

// The paint buffer is sized once, so a signal that changed size has to be
// rebuilt rather than painted through a buffer of the wrong shape.
func TestASignalThatChangesSizeIsRebuilt(t *testing.T) {
	manager := fixedCopilotManager(t)

	frame := CopilotFrame{
		MarkID: "mark-1", SessionID: "session-1", Corner: "top-left",
		Width: 100, Height: 100,
	}
	if err := manager.Frame(frame, testFrame(frame.Width, frame.Height)); err != nil {
		t.Fatalf("Frame: %v", err)
	}
	first := signalWindow(t, manager, "mark-1")

	frame.Width, frame.Height = 160, 120
	if err := manager.Frame(frame, testFrame(frame.Width, frame.Height)); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if second := signalWindow(t, manager, "mark-1"); second == first {
		t.Fatal("the window was reused at a different size")
	}
	if alive, _, _ := procIsWindow.Call(first); alive != 0 {
		t.Error("the replaced window was left open")
	}
	if manager.Count() != 1 {
		t.Errorf("%d signals are on screen, want 1", manager.Count())
	}
}

// Signals occlude the very thing they point at, so the count is bounded and the
// bound is enforced here rather than by the page behaving.
func TestTheNumberOfSignalsIsBounded(t *testing.T) {
	manager := fixedCopilotManager(t)

	for index := range MaxCopilotOverlays {
		frame := CopilotFrame{
			MarkID: "mark-" + string(rune('a'+index)), SessionID: "session-1",
			Corner: CopilotPoint, Width: 60, Height: 60, X: 0.5, Y: 0.5,
		}
		if err := manager.Frame(frame, testFrame(frame.Width, frame.Height)); err != nil {
			t.Fatalf("signal %d: %v", index, err)
		}
	}

	over := CopilotFrame{
		MarkID: "mark-over", SessionID: "session-1",
		Corner: CopilotPoint, Width: 60, Height: 60, X: 0.5, Y: 0.5,
	}
	if err := manager.Frame(over, testFrame(over.Width, over.Height)); err == nil {
		t.Error("a signal past the bound was accepted")
	}
	if manager.Count() != MaxCopilotOverlays {
		t.Errorf("%d signals are on screen, want %d", manager.Count(), MaxCopilotOverlays)
	}
}

// A page that crashed mid-call stops refreshing. Nothing else would ever take
// its windows off the desktop.
func TestASignalNothingRefreshesIsClosed(t *testing.T) {
	manager := fixedCopilotManager(t)

	// A clock the test controls: the expiry rule is 1.2 seconds, and sleeping
	// through it would make this the slowest test in the package.
	var elapsed atomic.Int64
	manager.now = func() time.Time { return time.Unix(0, elapsed.Load()) }

	frame := CopilotFrame{
		MarkID: "mark-1", SessionID: "session-1", Corner: CopilotPoint,
		Width: 60, Height: 60, X: 0.5, Y: 0.5,
	}
	if err := manager.Frame(frame, testFrame(frame.Width, frame.Height)); err != nil {
		t.Fatalf("Frame: %v", err)
	}
	hwnd := signalWindow(t, manager, "mark-1")

	elapsed.Store(int64(copilotTimeout + time.Second))
	deadline := time.Now().Add(5 * time.Second)
	for manager.Count() > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	if manager.Count() != 0 {
		t.Fatal("a signal nothing refreshed stayed on screen")
	}
	if alive, _, _ := procIsWindow.Call(hwnd); alive != 0 {
		t.Error("the expired signal's window was left open")
	}
}

// When the share ends, every signal drawn over it has to go with it.
func TestSignalsCloseWhenTheShareEnds(t *testing.T) {
	var ended atomic.Bool
	manager := NewCopilotManager(func(string, bool) (Geometry, error) {
		if ended.Load() {
			return Geometry{}, errors.New("The native share ended or changed")
		}
		return fixedGeometry(), nil
	})
	t.Cleanup(manager.Shutdown)

	frame := CopilotFrame{
		MarkID: "mark-1", SessionID: "session-1", Corner: "bottom-right",
		Width: 200, Height: 140,
	}
	if err := manager.Frame(frame, testFrame(frame.Width, frame.Height)); err != nil {
		t.Fatalf("Frame: %v", err)
	}
	hwnd := signalWindow(t, manager, "mark-1")

	ended.Store(true)
	deadline := time.Now().Add(5 * time.Second)
	for manager.Count() > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	if manager.Count() != 0 {
		t.Fatal("signals survived the end of the share")
	}
	if alive, _, _ := procIsWindow.Call(hwnd); alive != 0 {
		t.Error("the window outlived the share")
	}
}

// A signal pinned to a point in a window must disappear while that window is
// behind another one, or it would float over whatever the person switched to.
// A corner-anchored card is a reference rather than a pointer, and stays.
func TestPointSignalsHideWhileTheShareIsNotInFront(t *testing.T) {
	var inFront atomic.Bool
	inFront.Store(true)
	manager := NewCopilotManager(func(_ string, requireForeground bool) (Geometry, error) {
		if requireForeground && !inFront.Load() {
			return Geometry{}, errors.New("Signals are hidden while another window is in front")
		}
		return fixedGeometry(), nil
	})
	t.Cleanup(manager.Shutdown)

	point := CopilotFrame{
		MarkID: "mark-point", SessionID: "session-1", Corner: CopilotPoint,
		Width: 80, Height: 80, X: 0.5, Y: 0.5,
	}
	card := CopilotFrame{
		MarkID: "mark-card", SessionID: "session-1", Corner: "top-right",
		Width: 200, Height: 140,
	}
	for _, frame := range []CopilotFrame{point, card} {
		if err := manager.Frame(frame, testFrame(frame.Width, frame.Height)); err != nil {
			t.Fatalf("%s: %v", frame.MarkID, err)
		}
	}
	pointWindow := signalWindow(t, manager, "mark-point")
	cardWindow := signalWindow(t, manager, "mark-card")

	inFront.Store(false)
	if err := manager.Frame(point, testFrame(point.Width, point.Height)); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if visible, _, _ := procIsWindowVisible.Call(pointWindow); visible != 0 {
		t.Error("a point signal stayed visible while another window was in front")
	}

	if err := manager.Frame(card, testFrame(card.Width, card.Height)); err != nil {
		t.Fatalf("refresh card: %v", err)
	}
	if visible, _, _ := procIsWindowVisible.Call(cardWindow); visible == 0 {
		t.Error("a corner-anchored card was hidden with the point signals")
	}

	inFront.Store(true)
	if err := manager.Frame(point, testFrame(point.Width, point.Height)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if visible, _, _ := procIsWindowVisible.Call(pointWindow); visible == 0 {
		t.Error("the point signal did not come back when the share returned to the front")
	}
}
