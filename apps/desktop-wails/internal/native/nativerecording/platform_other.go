//go:build !windows

package nativerecording

import "os/exec"

func hideWindow(*exec.Cmd) {}
