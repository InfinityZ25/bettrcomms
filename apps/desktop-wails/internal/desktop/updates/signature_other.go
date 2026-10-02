//go:build !windows && (!darwin || ios)

package updates

import "errors"

func VerifyPlatformSignature(string, string) error {
	return errors.New("Updates are unavailable on this platform")
}
