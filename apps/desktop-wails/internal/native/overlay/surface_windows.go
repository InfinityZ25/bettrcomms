//go:build windows

package overlay

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procCreateWindowExW          = user32.NewProc("CreateWindowExW")
	procDestroyWindow            = user32.NewProc("DestroyWindow")
	procDefWindowProcW           = user32.NewProc("DefWindowProcW")
	procRegisterClassExW         = user32.NewProc("RegisterClassExW")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procSetWindowLongPtrW        = user32.NewProc("SetWindowLongPtrW")
	procUpdateLayeredWindow      = user32.NewProc("UpdateLayeredWindow")
	procSetWindowDisplayAffinity = user32.NewProc("SetWindowDisplayAffinity")
	procMonitorFromWindow        = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW          = user32.NewProc("GetMonitorInfoW")
	procGetDC                    = user32.NewProc("GetDC")
	procReleaseDC                = user32.NewProc("ReleaseDC")
	procPeekMessageW             = user32.NewProc("PeekMessageW")
	procTranslateMessage         = user32.NewProc("TranslateMessage")
	procDispatchMessageW         = user32.NewProc("DispatchMessageW")
	procShowWindow               = user32.NewProc("ShowWindow")

	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
	procSelectObject       = gdi32.NewProc("SelectObject")

	procGetModuleHandleW      = kernel32.NewProc("GetModuleHandleW")
	procGetCurrentThreadIDNow = kernel32.NewProc("GetCurrentThreadId")
)

const (
	wsExLayered     = 0x00080000
	wsExTransparent = 0x00000020
	wsExToolWindow  = 0x00000080
	wsExTopmost     = 0x00000008
	wsExNoActivate  = 0x08000000
	wsPopup         = 0x80000000

	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoActivate = 0x0010
	swpShowWindow = 0x0040

	// swHide takes a placed overlay off the screen without destroying it, which
	// is how a signal pointing at a window disappears while that window is
	// behind another one.
	swHide = 0

	hwndTopmost = ^uintptr(0) // (HWND)-1

	ulwAlpha                = 0x00000002
	acSrcOver               = 0x00
	acSrcAlpha              = 0x01
	biRGB                   = 0
	dibRGBColors            = 0
	monitorDefaultToNearest = 2

	// wdaExcludeFromCapture keeps the overlay out of every screen capture,
	// including this application's own. Without it, sharing a display would
	// show the viewer the overlay drawn on top of the share.
	wdaExcludeFromCapture = 0x00000011
)

// gwlExStyleIndex is GWL_EXSTYLE. It is a variable rather than a constant
// because a negative constant cannot be converted to uintptr at compile time;
// the conversion has to happen at runtime so it sign-extends.
var gwlExStyleIndex = int32(-20)

type point struct{ X, Y int32 }

type size struct{ CX, CY int32 }

type rect struct{ Left, Top, Right, Bottom int32 }

type monitorInfo struct {
	Size    uint32
	Monitor rect
	Work    rect
	Flags   uint32
}

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type bitmapInfo struct {
	Header bitmapInfoHeader
	Colors [1]uint32
}

type blendFunction struct {
	BlendOp             byte
	BlendFlags          byte
	SourceConstantAlpha byte
	AlphaFormat         byte
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type msg struct {
	HWND    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Point   point
}

// surface is the opaque handle the portable half passes around.
type surface interface{ closed() bool }

// windowSurface owns the layered window and its paint buffer.
//
// Every Win32 call for this window happens on one OS-locked thread. A window
// belongs to the thread that created it, and a device context obtained with
// GetDC must be released on that thread, so the whole lifetime is serialised
// onto a single goroutine driving that thread.
type windowSurface struct {
	commands chan func()
	quit     chan struct{}
	done     chan struct{}
	threadID uint32

	hwnd   uintptr
	screen uintptr
	memory uintptr
	bitmap uintptr
	old    uintptr
	bits   unsafe.Pointer
	width  uint32
	height uint32

	once sync.Once
	shut bool
}

func (s *windowSurface) closed() bool { return s == nil || s.shut }

// run executes fn on the surface's own thread and waits for it.
func (s *windowSurface) run(fn func() error) error {
	if s == nil || s.shut {
		return ErrClosed
	}
	result := make(chan error, 1)
	select {
	case s.commands <- func() { result <- fn() }:
	case <-s.done:
		return ErrClosed
	}
	select {
	case err := <-result:
		return err
	case <-s.done:
		return ErrClosed
	}
}

var overlayClass struct {
	once sync.Once
	name *uint16
	err  error
}

// windowProc does nothing but the default: the overlay has no input to handle,
// which is the point of a click-through tile.
var windowProc = syscall.NewCallback(func(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	result, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return result
})

func registerClass() (*uint16, error) {
	overlayClass.once.Do(func() {
		name, err := windows.UTF16PtrFromString("BettercommsCameraOverlay")
		if err != nil {
			overlayClass.err = err
			return
		}
		instance, _, _ := procGetModuleHandleW.Call(0)
		class := wndClassEx{
			Size:      uint32(unsafe.Sizeof(wndClassEx{})),
			WndProc:   windowProc,
			Instance:  windows.Handle(instance),
			ClassName: name,
		}
		if atom, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
			// A class registered by an earlier open is not an error.
			if errno, ok := err.(syscall.Errno); !ok || errno != 1410 { // ERROR_CLASS_ALREADY_EXISTS
				overlayClass.err = fmt.Errorf("Could not register the camera overlay window class: %w", err)
				return
			}
		}
		overlayClass.name = name
	})
	return overlayClass.name, overlayClass.err
}

func overlayStyle(clickThrough bool) uintptr {
	style := uintptr(wsExLayered | wsExNoActivate | wsExToolWindow | wsExTopmost)
	if clickThrough {
		style |= wsExTransparent
	}
	return style
}

// cornerPosition places the overlay inside the nearest monitor's work area,
// inset so it does not sit flush against the edge.
func cornerPosition(hwnd uintptr, width, height uint32, position Position) (int32, int32, uint32, uint32, error) {
	monitor, _, _ := procMonitorFromWindow.Call(hwnd, monitorDefaultToNearest)
	info := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	if ok, _, err := procGetMonitorInfoW.Call(monitor, uintptr(unsafe.Pointer(&info))); ok == 0 {
		return 0, 0, 0, 0, fmt.Errorf("Could not measure the display for the camera overlay: %w", err)
	}

	area := info.Work
	const margin = 24

	// The overlay never exceeds the work area: a stack of tiles taller than the
	// screen would otherwise run off it.
	available := uint32(area.Right - area.Left)
	if width > available {
		width = available
	}
	available = uint32(area.Bottom - area.Top)
	if height > available {
		height = available
	}

	left, top := area.Left+margin, area.Top+margin
	switch position {
	case TopRight:
		left = area.Right - int32(width) - margin
	case BottomLeft:
		top = area.Bottom - int32(height) - margin
	case BottomRight:
		left = area.Right - int32(width) - margin
		top = area.Bottom - int32(height) - margin
	}
	if left < area.Left {
		left = area.Left
	}
	if top < area.Top {
		top = area.Top
	}
	return left, top, width, height, nil
}

func (s *windowSurface) createBuffer(width, height uint32) error {
	s.releaseBuffer()

	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return fmt.Errorf("Could not access display for camera overlay")
	}
	memory, _, _ := procCreateCompatibleDC.Call(screen)
	if memory == 0 {
		procReleaseDC.Call(0, screen)
		return fmt.Errorf("Could not create camera overlay buffer")
	}

	info := bitmapInfo{Header: bitmapInfoHeader{
		Size:  uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width: int32(width),
		// Negative height makes the DIB top-down, matching the row order the
		// frame arrives in. A bottom-up DIB would show the camera upside down.
		Height:      -int32(height),
		Planes:      1,
		BitCount:    32,
		Compression: biRGB,
	}}
	var bits unsafe.Pointer
	bitmap, _, err := procCreateDIBSection.Call(
		memory,
		uintptr(unsafe.Pointer(&info)),
		dibRGBColors,
		uintptr(unsafe.Pointer(&bits)),
		0, 0,
	)
	if bitmap == 0 {
		procDeleteDC.Call(memory)
		procReleaseDC.Call(0, screen)
		return fmt.Errorf("Could not create the camera overlay bitmap: %w", err)
	}
	old, _, _ := procSelectObject.Call(memory, bitmap)

	s.screen, s.memory, s.bitmap, s.old = screen, memory, bitmap, old
	s.bits, s.width, s.height = bits, width, height
	return nil
}

func (s *windowSurface) releaseBuffer() {
	if s.memory == 0 {
		return
	}
	procSelectObject.Call(s.memory, s.old)
	procDeleteObject.Call(s.bitmap)
	procDeleteDC.Call(s.memory)
	procReleaseDC.Call(0, s.screen)
	s.screen, s.memory, s.bitmap, s.old, s.bits = 0, 0, 0, 0, nil
}

// openSurface creates the overlay window on its own thread.
func openSurface(width, height uint32, position Position, clickThrough bool) (surface, uint32, uint32, error) {
	className, err := registerClass()
	if err != nil {
		return nil, 0, 0, err
	}

	s := &windowSurface{
		commands: make(chan func()),
		quit:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	type ready struct {
		width, height uint32
		err           error
	}
	started := make(chan ready, 1)

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(s.done)

		// A message queue must exist before the window does.
		var message msg
		procPeekMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0, 0)
		threadID, _, _ := procGetCurrentThreadIDNow.Call()
		s.threadID = uint32(threadID)

		instance, _, _ := procGetModuleHandleW.Call(0)
		hwnd, _, createErr := procCreateWindowExW.Call(
			overlayStyle(clickThrough),
			uintptr(unsafe.Pointer(className)),
			uintptr(unsafe.Pointer(className)),
			wsPopup,
			0, 0, uintptr(width), uintptr(height),
			0, 0, instance, 0,
		)
		if hwnd == 0 {
			started <- ready{err: fmt.Errorf("Could not create the camera overlay window: %w", createErr)}
			return
		}
		s.hwnd = hwnd

		// Excluded from capture before it is ever shown, so it cannot appear in
		// a share even for one frame.
		if ok, _, affinityErr := procSetWindowDisplayAffinity.Call(hwnd, wdaExcludeFromCapture); ok == 0 {
			procDestroyWindow.Call(hwnd)
			started <- ready{err: fmt.Errorf("Could not exclude the camera overlay from screen capture: %w", affinityErr)}
			return
		}

		left, top, fittedWidth, fittedHeight, err := cornerPosition(hwnd, width, height, position)
		if err != nil {
			procDestroyWindow.Call(hwnd)
			started <- ready{err: err}
			return
		}
		procSetWindowPos.Call(hwnd, hwndTopmost,
			uintptr(left), uintptr(top), uintptr(fittedWidth), uintptr(fittedHeight),
			swpNoActivate)

		if err := s.createBuffer(fittedWidth, fittedHeight); err != nil {
			procDestroyWindow.Call(hwnd)
			started <- ready{err: err}
			return
		}
		started <- ready{width: fittedWidth, height: fittedHeight}

		// Commands and window messages share this thread. The ticker is what
		// keeps the pump running while no command is waiting; blocking on the
		// command channel alone would leave window messages unserviced.
		pump := time.NewTicker(16 * time.Millisecond)
		defer pump.Stop()
		for {
			select {
			case command := <-s.commands:
				command()
			case <-s.quit:
				return
			case <-pump.C:
				for {
					got, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0, 1)
					if got == 0 {
						break
					}
					procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
					procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
				}
			}
		}
	}()

	result := <-started
	if result.err != nil {
		<-s.done
		return nil, 0, 0, result.err
	}
	return s, result.width, result.height, nil
}

// configureSurface moves, resizes, and re-styles an open overlay.
func configureSurface(handle surface, width, height uint32, position Position, clickThrough bool) (uint32, uint32, error) {
	s, ok := handle.(*windowSurface)
	if !ok || s.closed() {
		return 0, 0, ErrClosed
	}

	var fittedWidth, fittedHeight uint32
	err := s.run(func() error {
		procSetWindowLongPtrW.Call(s.hwnd, uintptr(gwlExStyleIndex), overlayStyle(clickThrough))

		left, top, w, h, err := cornerPosition(s.hwnd, width, height, position)
		if err != nil {
			return err
		}
		procSetWindowPos.Call(s.hwnd, hwndTopmost,
			uintptr(left), uintptr(top), uintptr(w), uintptr(h), swpNoActivate)

		if w != s.width || h != s.height {
			if err := s.createBuffer(w, h); err != nil {
				return err
			}
		}
		fittedWidth, fittedHeight = w, h
		return nil
	})
	return fittedWidth, fittedHeight, err
}

// paintSurface writes one premultiplied BGRA frame to the layered window.
func paintSurface(handle surface, width, height uint32, bgra []byte, show bool) error {
	s, ok := handle.(*windowSurface)
	if !ok || s.closed() {
		return ErrClosed
	}
	if uint64(len(bgra)) != uint64(width)*uint64(height)*4 {
		return fmt.Errorf("Camera overlay frame does not match the surface")
	}

	return s.run(func() error {
		if s.bits == nil || s.width != width || s.height != height {
			return fmt.Errorf("Camera overlay surface changed size mid-frame")
		}
		copy(unsafe.Slice((*byte)(s.bits), len(bgra)), bgra)

		source := point{}
		surfaceSize := size{CX: int32(width), CY: int32(height)}
		blend := blendFunction{
			BlendOp:             acSrcOver,
			SourceConstantAlpha: 255,
			AlphaFormat:         acSrcAlpha,
		}
		ok, _, err := procUpdateLayeredWindow.Call(
			s.hwnd, 0,
			0, // keep the current position
			uintptr(unsafe.Pointer(&surfaceSize)),
			s.memory,
			uintptr(unsafe.Pointer(&source)),
			0,
			uintptr(unsafe.Pointer(&blend)),
			ulwAlpha,
		)
		if ok == 0 {
			return fmt.Errorf("Could not paint the camera overlay: %w", err)
		}
		if show {
			procSetWindowPos.Call(s.hwnd, hwndTopmost, 0, 0, 0, 0,
				swpNoMove|swpNoSize|swpNoActivate|swpShowWindow)
		}
		return nil
	})
}

// closeSurface destroys the overlay window and releases its buffer.
func closeSurface(handle surface) {
	s, ok := handle.(*windowSurface)
	if !ok || s == nil {
		return
	}
	s.once.Do(func() {
		_ = s.run(func() error {
			s.releaseBuffer()
			if s.hwnd != 0 {
				procDestroyWindow.Call(s.hwnd)
				s.hwnd = 0
			}
			return nil
		})
		s.shut = true
		close(s.quit)
		<-s.done
	})
}

// placeSurface moves an open overlay to an absolute virtual-desktop position
// and shows or hides it.
//
// Position comes from the caller rather than a corner preset because a
// visual-copilot signal points at a place inside the shared source, which is
// wherever the person moved that window to.
func placeSurface(handle surface, left, top int32, visible bool) error {
	s, ok := handle.(*windowSurface)
	if !ok || s.closed() {
		return ErrClosed
	}
	return s.run(func() error {
		if !visible {
			procShowWindow.Call(s.hwnd, swHide)
			return nil
		}
		if ok, _, err := procSetWindowPos.Call(s.hwnd, hwndTopmost,
			uintptr(left), uintptr(top), 0, 0,
			swpNoActivate|swpNoSize|swpShowWindow); ok == 0 {
			return fmt.Errorf("Could not place the overlay: %w", err)
		}
		return nil
	})
}
