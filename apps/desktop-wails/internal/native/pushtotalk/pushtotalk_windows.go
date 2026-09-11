//go:build windows

package pushtotalk

import (
	"errors"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const supported = true

var (
	user32                    = windows.NewLazySystemDLL("user32.dll")
	procSetWindowsHookExW     = user32.NewProc("SetWindowsHookExW")
	procUnhookWindowsHookEx   = user32.NewProc("UnhookWindowsHookEx")
	procCallNextHookEx        = user32.NewProc("CallNextHookEx")
	procGetMessageW           = user32.NewProc("GetMessageW")
	procPeekMessageW          = user32.NewProc("PeekMessageW")
	procPostThreadMessageW    = user32.NewProc("PostThreadMessageW")
	procSetTimer              = user32.NewProc("SetTimer")
	procKillTimer             = user32.NewProc("KillTimer")
	procGetAsyncKeyState      = user32.NewProc("GetAsyncKeyState")
	procMapVirtualKeyW        = user32.NewProc("MapVirtualKeyW")
	kernel32                  = windows.NewLazySystemDLL("kernel32.dll")
	procGetModuleHandleW      = kernel32.NewProc("GetModuleHandleW")
	procGetCurrentThreadIDNow = kernel32.NewProc("GetCurrentThreadId")
)

const (
	whKeyboardLL = 13
	whMouseLL    = 14

	wmKeyDown    = 0x0100
	wmKeyUp      = 0x0101
	wmSysKeyDown = 0x0104
	wmSysKeyUp   = 0x0105
	wmTimer      = 0x0113
	wmQuit       = 0x0012
	wmApp        = 0x8000
	// wmChanged wakes the worker's loop when the hook saw a transition. The
	// hook callback itself does no publishing: it must return promptly or
	// Windows removes it.
	wmChanged = wmApp + 47

	wmLButtonDown = 0x0201
	wmLButtonUp   = 0x0202
	wmRButtonDown = 0x0204
	wmRButtonUp   = 0x0205
	wmMButtonDown = 0x0207
	wmMButtonUp   = 0x0208
	wmXButtonDown = 0x020B
	wmXButtonUp   = 0x020C

	llkhfExtended    = 0x01
	mapvkVSCToVKEx   = 3
	watchdogInterval = 250
	registerTimeout  = 3 * time.Second
)

// kbdLLHookStruct mirrors KBDLLHOOKSTRUCT.
type kbdLLHookStruct struct {
	VKCode      uint32
	ScanCode    uint32
	Flags       uint32
	Time        uint32
	DWExtraInfo uintptr
}

// msLLHookStruct mirrors MSLLHOOKSTRUCT.
type msLLHookStruct struct {
	Point       struct{ X, Y int32 }
	MouseData   uint32
	Flags       uint32
	Time        uint32
	DWExtraInfo uintptr
}

type msg struct {
	HWND    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Point   struct{ X, Y int32 }
}

// hookSession is the state the hook callback reads. Only one session exists at
// a time, and the worker thread owns it, but the callback can be entered from
// the same thread re-entrantly, so it is mutex-guarded rather than assumed.
type hookSession struct {
	mu       sync.Mutex
	watching input
	state    *inputState
	vk       uint32
	threadID uint32
}

var active struct {
	mu      sync.Mutex
	current *hookSession
}

func currentSession() *hookSession {
	active.mu.Lock()
	defer active.mu.Unlock()
	return active.current
}

// change records a transition and wakes the worker loop if the derived state
// moved. It never suppresses the input.
func change(seen input, down bool, vk uint32) {
	session := currentSession()
	if session == nil {
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.watching != seen {
		return
	}
	session.vk = vk
	if session.state.update(down) {
		postThreadMessage(session.threadID, wmChanged)
	}
}

var keyboardCallback = syscall.NewCallback(func(code int32, message uintptr, data unsafe.Pointer) uintptr {
	if code >= 0 {
		switch uint32(message) {
		case wmKeyDown, wmSysKeyDown, wmKeyUp, wmSysKeyUp:
			key := (*kbdLLHookStruct)(data)
			change(
				input{keyboard: true, scan: key.ScanCode, extended: key.Flags&llkhfExtended != 0},
				uint32(message) == wmKeyDown || uint32(message) == wmSysKeyDown,
				key.VKCode,
			)
		}
	}
	return callNextHook(code, message, data)
})

var mouseCallback = syscall.NewCallback(func(code int32, message uintptr, data unsafe.Pointer) uintptr {
	if code >= 0 {
		mouse := (*msLLHookStruct)(data)
		var (
			button uint8
			down   bool
			vk     uint32
			known  bool
		)
		switch uint32(message) {
		case wmLButtonDown:
			button, down, vk, known = 0, true, 1, true
		case wmLButtonUp:
			button, down, vk, known = 0, false, 1, true
		case wmMButtonDown:
			button, down, vk, known = 1, true, 4, true
		case wmMButtonUp:
			button, down, vk, known = 1, false, 4, true
		case wmRButtonDown:
			button, down, vk, known = 2, true, 2, true
		case wmRButtonUp:
			button, down, vk, known = 2, false, 2, true
		case wmXButtonDown, wmXButtonUp:
			pressed := uint32(message) == wmXButtonDown
			switch mouse.MouseData >> 16 {
			case 1:
				button, down, vk, known = 3, pressed, 5, true
			case 2:
				button, down, vk, known = 4, pressed, 6, true
			}
		}
		if known {
			change(input{button: button}, down, vk)
		}
	}
	return callNextHook(code, message, data)
})

func callNextHook(code int32, message uintptr, data unsafe.Pointer) uintptr {
	result, _, _ := procCallNextHookEx.Call(0, uintptr(code), message, uintptr(data))
	return result
}

func postThreadMessage(threadID uint32, message uint32) {
	procPostThreadMessageW.Call(uintptr(threadID), uintptr(message), 0, 0)
}

func asyncKeyDown(vk uint32) bool {
	state, _, _ := procGetAsyncKeyState.Call(uintptr(int32(vk)))
	return int16(state) < 0
}

// worker owns the hook thread.
type worker struct {
	threadID uint32
	done     chan struct{}
	once     sync.Once
}

func (w *worker) stop() {
	if w == nil {
		return
	}
	w.once.Do(func() {
		postThreadMessage(w.threadID, wmQuit)
	})
	<-w.done
}

// startWorker installs the hook on a dedicated thread and runs its message
// loop there.
//
// The thread is locked to an OS thread for its whole life: a low-level hook is
// owned by the thread that installed it, and its callback is delivered to that
// thread's message queue, so Go must not migrate the goroutine.
func startWorker(watching input, state *shared, options Options) (*worker, error) {
	type registration struct {
		threadID uint32
		err      error
	}
	ready := make(chan registration, 1)
	done := make(chan struct{})

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(done)

		// Force a message queue onto this thread before the hook is installed,
		// so a transition posted from the callback cannot be dropped.
		var message msg
		procPeekMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0, 0)

		threadID, _, _ := procGetCurrentThreadIDNow.Call()
		vk := virtualKey(watching)
		session := &hookSession{
			watching: watching,
			state:    newInputState(asyncKeyDown(vk)),
			vk:       vk,
			threadID: uint32(threadID),
		}

		module, _, _ := procGetModuleHandleW.Call(0)
		hookID := uintptr(whKeyboardLL)
		callback := keyboardCallback
		if !watching.keyboard {
			hookID, callback = whMouseLL, mouseCallback
		}
		hook, _, err := procSetWindowsHookExW.Call(hookID, callback, module, 0)
		if hook == 0 {
			ready <- registration{err: wrap("Windows could not register global input", err)}
			return
		}
		defer procUnhookWindowsHookEx.Call(hook)

		timer, _, err := procSetTimer.Call(0, 0, watchdogInterval, 0)
		if timer == 0 {
			ready <- registration{err: wrap("Global input watchdog could not start", err)}
			return
		}
		defer procKillTimer.Call(0, timer)

		active.mu.Lock()
		active.current = session
		active.mu.Unlock()
		defer func() {
			active.mu.Lock()
			if active.current == session {
				active.current = nil
			}
			active.mu.Unlock()
		}()

		ready <- registration{threadID: uint32(threadID)}

		for {
			result, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
			if int32(result) <= 0 {
				break
			}
			if message.Message == wmTimer {
				if state.expired() || !options.trusted() {
					break
				}
				// Reconcile a release missed during a desktop switch or a
				// UAC prompt, where the hook stops being called mid-hold.
				// Done here rather than in the callback, which must return
				// promptly.
				session.mu.Lock()
				if !asyncKeyDown(session.vk) && session.state.update(false) {
					session.mu.Unlock()
					publish(session, state, options, true)
				} else {
					session.mu.Unlock()
				}
			}
			if message.Message == wmChanged {
				publish(session, state, options, true)
			}
		}

		// A worker that is going away reports the binding released, so the
		// microphone cannot be left open by a session that ended mid-hold.
		session.mu.Lock()
		session.state.update(false)
		session.mu.Unlock()
		publish(session, state, options, false)
	}()

	select {
	case result := <-ready:
		if result.err != nil {
			<-done
			return nil, result.err
		}
		return &worker{threadID: result.threadID, done: done}, nil
	case <-time.After(registerTimeout):
		return nil, errors.New("Global input registration timed out")
	}
}

func publish(session *hookSession, state *shared, options Options, healthy bool) {
	session.mu.Lock()
	pressed, sequence := session.state.pressed, session.state.sequence
	session.mu.Unlock()
	options.emit(state.publish(pressed, sequence, healthy, options.focused()))
}

// virtualKey is the key the watchdog polls with GetAsyncKeyState. A scan code
// is not a virtual key, so a keyboard binding is mapped; the mouse buttons
// have fixed virtual-key codes.
func virtualKey(watching input) uint32 {
	if !watching.keyboard {
		return [...]uint32{1, 4, 2, 5, 6}[watching.button]
	}
	scan := watching.scan
	if watching.extended {
		scan |= 0xe000
	}
	vk, _, _ := procMapVirtualKeyW.Call(uintptr(scan), mapvkVSCToVKEx)
	return uint32(vk)
}

func wrap(message string, err error) error {
	if err == nil || err == windows.ERROR_SUCCESS {
		return errors.New(message)
	}
	return errors.New(message + ": " + err.Error())
}
