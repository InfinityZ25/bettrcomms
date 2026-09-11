//go:build !windows

package pushtotalk

import "errors"

const supported = false

// worker has nothing to own off Windows.
type worker struct{}

func (*worker) stop() {}

func startWorker(input, *shared, Options) (*worker, error) {
	return nil, errors.New("Global push-to-talk requires the Windows desktop app")
}
