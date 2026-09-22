//go:build windows

package nativescreen

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	gdi32                        = windows.NewLazySystemDLL("gdi32.dll")
	procEnumWindows              = user32.NewProc("EnumWindows")
	procEnumDisplayMonitors      = user32.NewProc("EnumDisplayMonitors")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procIsWindow                 = user32.NewProc("IsWindow")
	procIsIconic                 = user32.NewProc("IsIconic")
	procGetWindowTextW           = user32.NewProc("GetWindowTextW")
	procGetClassNameW            = user32.NewProc("GetClassNameW")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procGetWindowPlacement       = user32.NewProc("GetWindowPlacement")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procGetMonitorInfoW          = user32.NewProc("GetMonitorInfoW")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")

	dwmapi                    = windows.NewLazySystemDLL("dwmapi.dll")
	procDwmGetWindowAttribute = dwmapi.NewProc("DwmGetWindowAttribute")
)

// dwmwaExtendedFrameBounds asks DWM for the rectangle the window actually
// occupies. GetWindowRect includes invisible resize borders, which would make
// the encoder capture a region wider than what anyone can see.
const dwmwaExtendedFrameBounds = 9

func extendedFrameBounds(handle uintptr) (rect, error) {
	var bounds rect
	status, _, _ := procDwmGetWindowAttribute.Call(
		handle,
		dwmwaExtendedFrameBounds,
		uintptr(unsafe.Pointer(&bounds)),
		unsafe.Sizeof(bounds),
	)
	if int32(status) < 0 {
		return rect{}, fmt.Errorf("Windows could not measure the shared window (0x%x)", uint32(status))
	}
	return bounds, nil
}

// gdi32 is referenced so the lazy DLL is not reported unused; EnumDisplayMonitors
// lives in user32 on current Windows but the handle keeps the dependency explicit.
var _ = gdi32

type rect struct{ Left, Top, Right, Bottom int32 }

type point struct{ X, Y int32 }

// windowPlacement mirrors WINDOWPLACEMENT. A minimised window's real size is
// only available here: GetWindowRect reports the minimised placeholder.
type windowPlacement struct {
	Length         uint32
	Flags          uint32
	ShowCmd        uint32
	MinPosition    point
	MaxPosition    point
	NormalPosition rect
}

type monitorInfo struct {
	Size    uint32
	Monitor rect
	Work    rect
	Flags   uint32
}

// enumeration is the collector the Win32 callbacks append to.
//
// A Go pointer is never handed to Win32 through LPARAM. Enumeration is
// serialised by this mutex instead, which keeps the garbage collector out of
// the callback's way entirely.
var enumeration struct {
	mu      sync.Mutex
	sources []Source
	err     error
}

var monitorCallback = syscall.NewCallback(func(handle uintptr, _ uintptr, area *rect, _ uintptr) uintptr {
	id, err := newSourceID()
	if err != nil {
		enumeration.err = err
		return 1
	}
	enumeration.sources = append(enumeration.sources, Source{
		ID:       id,
		Kind:     "monitor",
		Name:     fmt.Sprintf("Display %d", countMonitors()+1),
		Width:    nonNegative(area.Right - area.Left),
		Height:   nonNegative(area.Bottom - area.Top),
		Category: "display",
		Handle:   handle,
	})
	return 1
})

func countMonitors() int {
	count := 0
	for _, source := range enumeration.sources {
		if source.Kind == "monitor" {
			count++
		}
	}
	return count
}

var windowCallback = syscall.NewCallback(func(handle uintptr, _ uintptr) uintptr {
	if visible, _, _ := procIsWindowVisible.Call(handle); visible == 0 {
		return 1
	}

	title := make([]uint16, 512)
	length, _, _ := procGetWindowTextW.Call(handle, uintptr(unsafe.Pointer(&title[0])), uintptr(len(title)))
	if length == 0 {
		return 1
	}

	minimised, _, _ := procIsIconic.Call(handle)
	var bounds rect
	var haveBounds bool
	if minimised != 0 {
		// A minimised window reports a placeholder rectangle, so its restored
		// placement is what describes the surface that would be captured.
		placement := windowPlacement{Length: uint32(unsafe.Sizeof(windowPlacement{}))}
		if ok, _, _ := procGetWindowPlacement.Call(handle, uintptr(unsafe.Pointer(&placement))); ok != 0 {
			bounds = placement.NormalPosition
			haveBounds = true
		}
	} else {
		if ok, _, _ := procGetWindowRect.Call(handle, uintptr(unsafe.Pointer(&bounds))); ok != 0 {
			haveBounds = true
		}
	}
	// Anything this small is a tooltip, a shadow, or a message-only window,
	// none of which anyone means to share.
	if !haveBounds || bounds.Right-bounds.Left <= 100 || bounds.Bottom-bounds.Top <= 100 {
		return 1
	}

	id, err := newSourceID()
	if err != nil {
		enumeration.err = err
		return 1
	}
	name := windows.UTF16ToString(title[:length])
	enumeration.sources = append(enumeration.sources, Source{
		ID:        id,
		Kind:      "window",
		Name:      name,
		Width:     nonNegative(bounds.Right - bounds.Left),
		Height:    nonNegative(bounds.Bottom - bounds.Top),
		Category:  sourceCategory(name, executableName(handle), windowClass(handle)),
		Minimized: minimised != 0,
		Handle:    handle,
	})
	return 1
})

func nonNegative(value int32) uint32 {
	if value < 0 {
		return 0
	}
	return uint32(value)
}

// executableName is the full image path of the window's process, used only to
// categorise it for the picker. An empty result simply means "uncategorised".
func executableName(handle uintptr) string {
	var processID uint32
	procGetWindowThreadProcessID.Call(handle, uintptr(unsafe.Pointer(&processID)))
	if processID == 0 {
		return ""
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, processID)
	if err != nil {
		return ""
	}
	defer func() { _ = windows.CloseHandle(process) }()

	path := make([]uint16, 1024)
	length := uint32(len(path))
	if err := windows.QueryFullProcessImageName(process, 0, &path[0], &length); err != nil {
		return ""
	}
	return windows.UTF16ToString(path[:length])
}

func windowClass(handle uintptr) string {
	class := make([]uint16, 256)
	length, _, _ := procGetClassNameW.Call(handle, uintptr(unsafe.Pointer(&class[0])), uintptr(len(class)))
	return windows.UTF16ToString(class[:length])
}

// enumerate lists every shareable display and window, ordered the way the
// picker presents them.
func enumerate() ([]Source, error) {
	enumeration.mu.Lock()
	defer enumeration.mu.Unlock()
	enumeration.sources = nil
	enumeration.err = nil

	procEnumDisplayMonitors.Call(0, 0, monitorCallback, 0)
	if ok, _, err := procEnumWindows.Call(windowCallback, 0); ok == 0 {
		// EnumWindows reports failure when a callback stopped it; the callbacks
		// here never do, so this is a real failure.
		if enumeration.err == nil {
			return nil, fmt.Errorf("Windows could not list open windows: %w", err)
		}
	}
	if enumeration.err != nil {
		return nil, enumeration.err
	}

	sources := enumeration.sources
	enumeration.sources = nil

	slices.SortStableFunc(sources, func(left, right Source) int {
		if order := cmp.Compare(sourceSortRank(left), sourceSortRank(right)); order != 0 {
			return order
		}
		// A minimised window sorts after a visible one of the same kind: it is
		// the less likely thing to be sharing.
		if left.Minimized != right.Minimized {
			if left.Minimized {
				return 1
			}
			return -1
		}
		return cmp.Compare(strings.ToLower(left.Name), strings.ToLower(right.Name))
	})
	return sources, nil
}

// liveWindowProcess resolves a captured window's audio process, refusing this
// application's own tree.
//
// The web client never supplies a PID or an HWND. It names a source by opaque
// ID, and the owner is resolved here from the last trusted enumeration, so a
// page cannot aim process-loopback capture at an arbitrary process.
func liveWindowProcess(handle uintptr) (uint32, error) {
	if alive, _, _ := procIsWindow.Call(handle); alive == 0 {
		return 0, errWindowClosed
	}
	var processID uint32
	procGetWindowThreadProcessID.Call(handle, uintptr(unsafe.Pointer(&processID)))
	if processID == 0 {
		return 0, errNoAudioProcess
	}
	self := uint32(windows.GetCurrentProcessId())
	if processID == self {
		return 0, errOwnAudio
	}
	descends, err := processDescendsFrom(processID, self)
	if err != nil {
		return 0, err
	}
	if descends {
		return 0, errOwnBrowserAudio
	}
	return processID, nil
}

// foregroundWindow is used only to decide whether a captured window is the one
// currently on top, for overlay placement.
func foregroundWindow() uintptr {
	handle, _, _ := procGetForegroundWindow.Call()
	return handle
}

// monitorBounds is the virtual-desktop rectangle of a display.
func monitorBounds(handle uintptr) (rect, error) {
	info := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	if ok, _, err := procGetMonitorInfoW.Call(handle, uintptr(unsafe.Pointer(&info))); ok == 0 {
		return rect{}, fmt.Errorf("Windows could not describe the shared display: %w", err)
	}
	return info.Monitor, nil
}
