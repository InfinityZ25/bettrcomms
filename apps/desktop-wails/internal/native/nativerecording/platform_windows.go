//go:build windows

package nativerecording

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps the muxer subprocess from flashing a console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
}
