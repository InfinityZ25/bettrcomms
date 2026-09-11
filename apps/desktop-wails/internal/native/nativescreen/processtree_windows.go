//go:build windows

package nativescreen

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ntdll                         = windows.NewLazySystemDLL("ntdll.dll")
	procNtQueryInformationProcess = ntdll.NewProc("NtQueryInformationProcess")
)

var (
	errWindowClosed   = errors.New("The selected application closed. Refresh sources and choose it again")
	errNoAudioProcess = errors.New("Windows could not identify the selected application's audio process")
	errOwnAudio       = errors.New("BetterComms cannot capture its own call audio as application audio")
	// A window belonging to a child of this process is still this application:
	// the webview and its GPU process both are.
	errOwnBrowserAudio  = errors.New("BetterComms cannot capture its own browser or call audio as application audio")
	errUnverifiableTree = errors.New("Windows could not validate the selected application's process tree")
	errTreeTooDeep      = errors.New("The selected application's process tree was too deep to validate")
)

// processBasicInformation mirrors PROCESS_BASIC_INFORMATION. Only the parent
// PID is read; the reserved fields are present so the struct has the layout
// the kernel writes into.
type processBasicInformation struct {
	Reserved1                    uintptr
	PEBBaseAddress               uintptr
	Reserved2                    [2]uintptr
	UniqueProcessID              uintptr
	InheritedFromUniqueProcessID uintptr
}

// maxProcessTreeDepth bounds the walk. A cycle in reported parentage — which a
// recycled PID can produce — must not spin here.
const maxProcessTreeDepth = 64

// processDescendsFrom reports whether processID is ancestor, or descends from
// it.
//
// This is what stops the app from capturing its own audio through a window it
// spawned. A PID that cannot be opened partway up the walk is treated as a
// boundary, not a failure: it means the chain left this user's reach, which is
// itself proof it is not one of ours.
func processDescendsFrom(processID, ancestor uint32) (bool, error) {
	for depth := 0; depth < maxProcessTreeDepth; depth++ {
		process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, processID)
		if err != nil {
			if depth > 0 {
				return false, nil
			}
			return false, errUnverifiableTree
		}

		var information processBasicInformation
		status, _, _ := procNtQueryInformationProcess.Call(
			uintptr(process),
			0, // ProcessBasicInformation
			uintptr(unsafe.Pointer(&information)),
			unsafe.Sizeof(information),
			0,
		)
		_ = windows.CloseHandle(process)
		if int32(status) < 0 {
			return false, errUnverifiableTree
		}

		parent := uint32(information.InheritedFromUniqueProcessID)
		if parent == ancestor {
			return true, nil
		}
		// A parent of zero is the top of the tree; a self-parent is a recycled
		// PID reporting nonsense. Either way the walk is over.
		if parent == 0 || parent == processID {
			return false, nil
		}
		processID = parent
	}
	return false, errTreeTooDeep
}
