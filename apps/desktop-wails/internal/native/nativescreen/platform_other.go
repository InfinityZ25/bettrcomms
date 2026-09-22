//go:build !windows

package nativescreen

import (
	"errors"
	"os/exec"
)

const supportedPlatform = false

func hideWindow(*exec.Cmd) {}

func visibleBounds(Source) (uint32, uint32, bool) { return 0, 0, false }

func enumerate() ([]Source, error) {
	return nil, errors.New("Native screen capture is available on Windows only")
}

// liveWindowProcess has no meaning off Windows, where there is no capture.
func liveWindowProcess(uintptr) (uint32, error) {
	return 0, errors.New("Application audio capture is available on Windows only")
}

// sourceBounds has no meaning off Windows, where there is no capture to place
// an overlay over.
func sourceBounds(Source, bool) (int32, int32, uint32, uint32, error) {
	return 0, 0, 0, 0, errors.New("Visual overlays require Windows native sharing")
}
