//go:build windows

package deepfilter

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

/*
An install directory reached by its 8.3 short name is still the install
directory.

This is not a hypothetical: a GitHub Windows runner's temporary directory is
`C:\Users\RUNNER~1\...`, and EvalSymlinks answers in long names. Comparing a
resolved file against an unresolved root there rejected every file in a
perfectly good install, and no machine whose paths happen to be long — most
development machines — would ever show it.
*/
func TestTrustedFileAcceptsAnInstallDirectoryThatNeedsResolving(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "runtime"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "runtime", "onnxruntime.dll"),
		[]byte("dll"),
		0o644,
	); err != nil {
		t.Fatalf("write: %v", err)
	}

	short := shortName(root)
	if short == root {
		t.Skip("this volume has no 8.3 names, so there is nothing to resolve")
	}

	if _, err := trustedFile(short, "runtime/onnxruntime.dll", "runtime"); err != nil {
		t.Fatalf("a file inside the install directory was refused: %v", err)
	}

	// The refusals still refuse: resolving the root is not a way out of it.
	if _, err := trustedFile(short, "../onnxruntime.dll", "runtime"); err == nil {
		t.Error("a traversal was accepted")
	}
}

// shortName is the 8.3 form of a path, or the path when the volume has none.
func shortName(path string) string {
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return path
	}
	buffer := make([]uint16, windows.MAX_PATH)
	length, err := windows.GetShortPathName(wide, &buffer[0], uint32(len(buffer)))
	if err != nil || length == 0 || int(length) > len(buffer) {
		return path
	}
	return windows.UTF16ToString(buffer[:length])
}
