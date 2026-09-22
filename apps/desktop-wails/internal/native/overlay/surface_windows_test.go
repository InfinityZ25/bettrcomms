//go:build windows

package overlay

import (
	"errors"
	"testing"
	"time"
	"unsafe"
)

var (
	procIsWindow                 = user32.NewProc("IsWindow")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procGetWindowDisplayAffinity = user32.NewProc("GetWindowDisplayAffinity")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
)

// testFrame is an opaque RGBA buffer of the given size.
func testFrame(width, height uint32) []byte {
	frame := make([]byte, uint64(width)*uint64(height)*4)
	for index := 0; index+3 < len(frame); index += 4 {
		frame[index] = 0x20   // R
		frame[index+1] = 0x60 // G
		frame[index+2] = 0xa0 // B
		frame[index+3] = 0xff // A
	}
	return frame
}

func openTestOverlay(t *testing.T, options Options) (*Manager, Info) {
	t.Helper()
	manager := NewManager()
	t.Cleanup(manager.Shutdown)

	info, err := manager.Open(options)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return manager, info
}

// The overlay is a real layered window. This is the acceptance test: it exists,
// it is excluded from capture, and it accepts a painted frame.
func TestOpenCreatesARealLayeredWindow(t *testing.T) {
	manager, info := openTestOverlay(t, Options{
		Position:     TopRight,
		Size:         Small,
		ClickThrough: true,
		Rows:         1,
	})

	if info.OverlayID == "" {
		t.Error("the overlay has no id")
	}
	if info.Width == 0 || info.Height == 0 {
		t.Errorf("the overlay is %dx%d", info.Width, info.Height)
	}
	if info.MaxFPS != MaxFPS || info.MaxFrameBytes != MaxFrameBytes {
		t.Errorf("info does not carry the limits the page needs: %+v", info)
	}

	manager.mu.Lock()
	handle := manager.surface.(*windowSurface)
	manager.mu.Unlock()

	if alive, _, _ := procIsWindow.Call(handle.hwnd); alive == 0 {
		t.Fatal("no window was created")
	}

	// A camera tile drawn over a share must not appear inside that share.
	var affinity uint32
	if ok, _, err := procGetWindowDisplayAffinity.Call(handle.hwnd, uintptr(unsafe.Pointer(&affinity))); ok == 0 {
		t.Fatalf("GetWindowDisplayAffinity: %v", err)
	}
	if affinity != wdaExcludeFromCapture {
		t.Errorf("display affinity = %#x, want WDA_EXCLUDEFROMCAPTURE (%#x)", affinity, wdaExcludeFromCapture)
	}

	// Nothing is shown until the first frame: an empty window would flash.
	if visible, _, _ := procIsWindowVisible.Call(handle.hwnd); visible != 0 {
		t.Error("the overlay was visible before its first frame")
	}

	if err := manager.Frame(info.OverlayID, info.Width, info.Height, testFrame(info.Width, info.Height)); err != nil {
		t.Fatalf("Frame: %v", err)
	}
	if visible, _, _ := procIsWindowVisible.Call(handle.hwnd); visible == 0 {
		t.Error("the overlay is still hidden after a painted frame")
	}

	if err := manager.Close(info.OverlayID); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if alive, _, _ := procIsWindow.Call(handle.hwnd); alive != 0 {
		t.Error("the window outlived its overlay")
	}
}

// The overlay sits in the corner it was asked for, inside the work area.
func TestTheOverlayLandsInTheRequestedCorner(t *testing.T) {
	left, _ := openTestOverlay(t, Options{Position: TopLeft, Size: Small, Rows: 1})
	leftManager := left
	leftManager.mu.Lock()
	leftHandle := leftManager.surface.(*windowSurface)
	leftManager.mu.Unlock()
	leftBounds := windowBounds(t, leftHandle.hwnd)

	right, _ := openTestOverlay(t, Options{Position: BottomRight, Size: Small, Rows: 1})
	right.mu.Lock()
	rightHandle := right.surface.(*windowSurface)
	right.mu.Unlock()
	rightBounds := windowBounds(t, rightHandle.hwnd)

	if !(leftBounds.Left < rightBounds.Left) {
		t.Errorf("a top-left overlay at x=%d is not left of a bottom-right one at x=%d",
			leftBounds.Left, rightBounds.Left)
	}
	if !(leftBounds.Top < rightBounds.Top) {
		t.Errorf("a top-left overlay at y=%d is not above a bottom-right one at y=%d",
			leftBounds.Top, rightBounds.Top)
	}
}

func windowBounds(t *testing.T, hwnd uintptr) rect {
	t.Helper()
	var bounds rect
	if ok, _, err := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&bounds))); ok == 0 {
		t.Fatalf("GetWindowRect: %v", err)
	}
	return bounds
}

// Resizing the overlay rebuilds its paint buffer, and a frame at the old size
// is refused rather than read past.
func TestUpdateResizesTheSurface(t *testing.T) {
	manager, info := openTestOverlay(t, Options{Position: TopRight, Size: Small, Rows: 1})

	large := Large
	updated, err := manager.Update(info.OverlayID, Update{Size: &large})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Width == info.Width && updated.Height == info.Height {
		t.Errorf("the overlay is still %dx%d after resizing", updated.Width, updated.Height)
	}

	// A frame at the old size no longer matches the layout.
	if err := manager.Frame(info.OverlayID, info.Width, info.Height, testFrame(info.Width, info.Height)); err == nil {
		t.Error("a frame at the previous size was accepted")
	}
	// One at the new size is painted.
	if err := manager.Frame(info.OverlayID, updated.Width, updated.Height, testFrame(updated.Width, updated.Height)); err != nil {
		t.Errorf("a frame at the new size was refused: %v", err)
	}
}

// A stale grant must not drive an overlay that has since been replaced.
func TestAStaleGrantIsRefused(t *testing.T) {
	manager, first := openTestOverlay(t, Options{Position: TopRight, Size: Small, Rows: 1})

	second, err := manager.Open(Options{Position: TopLeft, Size: Small, Rows: 1})
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	if first.OverlayID == second.OverlayID {
		t.Fatal("the replacement reused the previous id")
	}

	if err := manager.Frame(first.OverlayID, first.Width, first.Height, testFrame(first.Width, first.Height)); !errors.Is(err, ErrStale) {
		t.Errorf("Frame err = %v, want ErrStale", err)
	}
	if _, err := manager.Update(first.OverlayID, Update{}); !errors.Is(err, ErrStale) {
		t.Errorf("Update err = %v, want ErrStale", err)
	}
	if err := manager.Close(first.OverlayID); !errors.Is(err, ErrStale) {
		t.Errorf("Close err = %v, want ErrStale", err)
	}
}

// Frames are paced. Sending faster than the paint rate must take real time
// rather than painting everything the page can produce.
func TestFramesArePaced(t *testing.T) {
	manager, info := openTestOverlay(t, Options{Position: TopRight, Size: Small, Rows: 1})
	frame := testFrame(info.Width, info.Height)

	const count = 6
	started := time.Now()
	for range count {
		if err := manager.Frame(info.OverlayID, info.Width, info.Height, frame); err != nil {
			t.Fatalf("Frame: %v", err)
		}
	}
	elapsed := time.Since(started)

	/*
	  Six frames at 24 fps is five intervals of waiting, less a hair.

	  Sleep is allowed to return marginally early — a Windows CI runner
	  measured 208.2594ms against a nominal 208.3333ms and failed the build on
	  74 microseconds. The difference this test exists to catch is pacing
	  against no pacing at all, which is three orders of magnitude larger than
	  the slack given here.
	*/
	const wakeSlack = time.Millisecond
	if minimum := (count-1)*minFrameInterval - wakeSlack; elapsed < minimum {
		t.Errorf("%d frames took %v, want at least %v of pacing", count, elapsed, minimum)
	}
}

// A page that stops sending frames must not leave a window on the desktop.
func TestAnUnfedOverlayClosesItself(t *testing.T) {
	manager, info := openTestOverlay(t, Options{Position: TopRight, Size: Small, Rows: 1})

	manager.mu.Lock()
	handle := manager.surface.(*windowSurface)
	manager.mu.Unlock()

	// Backdate the last frame past the timeout, then wait for a heartbeat.
	manager.mu.Lock()
	manager.current.lastFrame = time.Now().Add(-2 * frameTimeout)
	manager.mu.Unlock()

	deadline := time.Now().Add(3 * heartbeatInterval)
	for time.Now().Before(deadline) {
		if alive, _, _ := procIsWindow.Call(handle.hwnd); alive == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("the overlay %s was still open after its page stopped feeding it", info.OverlayID)
}
