//go:build !windows && (!darwin || ios || !cgo)

package startup

import "errors"

func status(string) (Status, error) {
	return Status{Detail: "Launch at login is unavailable on this platform."}, nil
}
func set(string, bool) (Status, error) {
	return Status{}, errors.New("Launch at login is unavailable on this platform")
}
