//go:build !windows

package systemaudio

import "errors"

var errUnsupported = errors.New("Native system audio requires the Windows desktop app")

func capture(<-chan struct{}, *ring, chan<- error, target) error { return errUnsupported }

func ownProcessTree() (uint32, error) { return 0, errUnsupported }

// windowsBuild reports no build off Windows, which makes Describe report the
// capability unavailable rather than guessing.
func windowsBuild() (uint32, bool) { return 0, false }
