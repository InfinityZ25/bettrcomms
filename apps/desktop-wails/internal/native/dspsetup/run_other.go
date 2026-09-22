//go:build !windows

package dspsetup

import (
	"context"
	"errors"
)

func requirePlainDirectory(string) error { return errors.New("native audio setup requires Windows") }
func runInstaller(context.Context, []string) error {
	return errors.New("native audio setup requires Windows")
}
