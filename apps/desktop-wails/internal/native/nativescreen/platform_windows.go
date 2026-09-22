//go:build windows

package nativescreen

import (
	"errors"
	"os/exec"
	"syscall"
)

const supportedPlatform = true

// hideWindow keeps the encoder subprocess from flashing a console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
}

// visibleBounds is the source's physical on-screen rectangle.
//
// The picker's dimensions can be stale, and a window's reported rectangle
// includes invisible resize borders. Encoding and overlay placement have to
// agree on one answer, so both take it from here.
func visibleBounds(source Source) (uint32, uint32, bool) {
	if source.Kind == "monitor" {
		bounds, err := monitorBounds(source.Handle)
		if err != nil {
			return 0, 0, false
		}
		return nonNegative(bounds.Right - bounds.Left), nonNegative(bounds.Bottom - bounds.Top), true
	}
	bounds, err := extendedFrameBounds(source.Handle)
	if err != nil {
		return 0, 0, false
	}
	return nonNegative(bounds.Right - bounds.Left), nonNegative(bounds.Bottom - bounds.Top), true
}

// sourceBounds is where the shared source sits on the virtual desktop.
//
// This is the same measurement visibleBounds makes, kept separate because it
// also reports the origin and enforces the liveness rules an overlay needs: a
// window that closed, was minimised, or is behind another one cannot carry a
// signal, and saying so is what makes the overlay disappear instead of floating
// over an unrelated application.
func sourceBounds(source Source, requireForeground bool) (int32, int32, uint32, uint32, error) {
	if source.Kind == "monitor" {
		bounds, err := monitorBounds(source.Handle)
		if err != nil {
			return 0, 0, 0, 0, err
		}
		return bounds.Left, bounds.Top,
			nonNegative(bounds.Right - bounds.Left), nonNegative(bounds.Bottom - bounds.Top), nil
	}

	if alive, _, _ := procIsWindow.Call(source.Handle); alive == 0 {
		return 0, 0, 0, 0, errors.New("The shared window is unavailable or minimized")
	}
	visible, _, _ := procIsWindowVisible.Call(source.Handle)
	iconic, _, _ := procIsIconic.Call(source.Handle)
	if visible == 0 || iconic != 0 {
		return 0, 0, 0, 0, errors.New("The shared window is unavailable or minimized")
	}
	if requireForeground && foregroundWindow() != source.Handle {
		return 0, 0, 0, 0, errors.New("Signals are hidden while another window is in front")
	}

	bounds, err := extendedFrameBounds(source.Handle)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	if bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top {
		return 0, 0, 0, 0, errors.New("The shared source has no visible area")
	}
	return bounds.Left, bounds.Top,
		nonNegative(bounds.Right - bounds.Left), nonNegative(bounds.Bottom - bounds.Top), nil
}
