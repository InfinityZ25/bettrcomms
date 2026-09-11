//go:build !windows

package overlay

import "errors"

// surface has no implementation off Windows: the overlay is a layered window,
// and no equivalent is ported here.
type surface interface{ closed() bool }

var errUnsupported = errors.New("The camera overlay requires the Windows desktop app")

func openSurface(uint32, uint32, Position, bool) (surface, uint32, uint32, error) {
	return nil, 0, 0, errUnsupported
}

func configureSurface(surface, uint32, uint32, Position, bool) (uint32, uint32, error) {
	return 0, 0, errUnsupported
}

func paintSurface(surface, uint32, uint32, []byte, bool) error { return errUnsupported }

func closeSurface(surface) {}

func placeSurface(surface, int32, int32, bool) error { return errUnsupported }
