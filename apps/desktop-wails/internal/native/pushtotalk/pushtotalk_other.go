//go:build !windows && (!darwin || ios || !cgo)

package pushtotalk

import "errors"

const supported = false

func validatePlatformInput(input) error {
	return errors.New("Native call shortcuts are unavailable on this platform")
}

// worker has nothing to own off Windows.
type worker struct{}

func (*worker) stop() {}

func startWorker([]watch, *shared, Options) (*worker, error) {
	return nil, errors.New("Global push-to-talk requires the Windows desktop app")
}

func Permission() PermissionStatus {
	return PermissionStatus{Detail: "Native call shortcuts are unavailable on this platform"}
}
func RequestPermission() PermissionStatus { return Permission() }
