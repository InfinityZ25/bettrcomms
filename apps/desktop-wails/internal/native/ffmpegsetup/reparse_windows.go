//go:build windows

package ffmpegsetup

import "golang.org/x/sys/windows"

// isReparsePoint reports whether a path is a junction, symlink, or other
// reparse point. Installing through one would let something outside the user
// profile decide where a verified binary lands.
func isReparsePoint(path string) (bool, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false, err
	}
	attributes, err := windows.GetFileAttributes(name)
	if err != nil {
		return false, err
	}
	return attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0, nil
}
