//go:build windows

package desktop

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	shell32            = windows.NewLazySystemDLL("shell32.dll")
	procShellExecuteEx = shell32.NewProc("ShellExecuteExW")
)

// shellExecuteInfo is SHELLEXECUTEINFOW. Only the fields this call sets are
// named; the rest are the trailing members the structure must still carry for
// its declared size to be right.
type shellExecuteInfo struct {
	Size          uint32
	Mask          uint32
	Window        uintptr
	Verb          *uint16
	File          *uint16
	Parameters    *uint16
	Directory     *uint16
	Show          int32
	InstApp       uintptr
	IDList        uintptr
	Class         *uint16
	KeyClass      uintptr
	HotKey        uint32
	IconOrMonitor uintptr
	Process       uintptr
}

const (
	// seeMaskNoAsync lets the call return before the browser has finished
	// starting, which it must, because this process does not wait for it.
	seeMaskNoAsync = 0x00000100
	// seeMaskFlagNoUI keeps Windows from putting up its own error dialog. A
	// failure is reported to the window, which can offer the address instead.
	seeMaskFlagNoUI = 0x00000400
	swShowNormal    = 1
)

// shellOpen hands a URI to whatever the person has registered to handle it —
// their browser for a web address, the Settings app for ms-settings.
//
// ShellExecuteEx is the documented way to do this and is what "open with the
// default handler" means on Windows. It is used in preference to spawning a
// shell: there is no command line to quote, so a URI cannot be read as
// anything but a URI.
func shellOpen(target string) error {
	verb, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	file, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return fmt.Errorf("the address could not be opened: %w", err)
	}

	info := shellExecuteInfo{
		Mask: seeMaskNoAsync | seeMaskFlagNoUI,
		Verb: verb,
		File: file,
		Show: swShowNormal,
	}
	info.Size = uint32(unsafe.Sizeof(info))

	if ok, _, callErr := procShellExecuteEx.Call(uintptr(unsafe.Pointer(&info))); ok == 0 {
		return fmt.Errorf("Windows could not open %s: %w", target, callErr)
	}
	return nil
}
