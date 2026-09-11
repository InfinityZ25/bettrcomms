//go:build !windows

package nativeprocess

import (
	"errors"
	"os/exec"
)

func attach(*exec.Cmd) error {
	return errors.New("Native process ownership is available on Windows only")
}
