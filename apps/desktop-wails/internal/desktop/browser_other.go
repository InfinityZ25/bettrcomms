//go:build !windows

package desktop

import (
	"fmt"
	"os/exec"
	"runtime"
)

// shellOpen hands a URI to the desktop's own handler.
//
// This host is built and shipped for Windows; the other platforms are here so
// the package compiles and its tests run everywhere, and they use each
// platform's standard opener rather than pretending the operation is
// unavailable.
func shellOpen(target string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", target)
	default:
		command = exec.Command("xdg-open", target)
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("could not open %s: %w", target, err)
	}
	// The browser outlives this call. Reaping it keeps no zombie behind.
	go func() { _ = command.Wait() }()
	return nil
}
