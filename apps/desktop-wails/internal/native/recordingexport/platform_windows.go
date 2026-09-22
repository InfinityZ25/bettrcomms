//go:build windows

package recordingexport

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps the conversion subprocess from flashing a console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
}
