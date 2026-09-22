//go:build !windows

package ffmpegsetup

import "os"

// isReparsePoint reports a symlink, the nearest equivalent off Windows. The
// pinned runtime is Windows-only, so this exists to keep the install path
// compiling and testable rather than to guard a real install.
func isReparsePoint(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	return info.Mode()&os.ModeSymlink != 0, nil
}
