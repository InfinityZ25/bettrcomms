//go:build !windows

package recordingexport

import "os/exec"

func hideWindow(*exec.Cmd) {}
