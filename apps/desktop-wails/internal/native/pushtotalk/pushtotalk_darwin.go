//go:build darwin && !ios && cgo

package pushtotalk

/*
#cgo LDFLAGS: -framework CoreGraphics -framework CoreFoundation
#include "pushtotalk_darwin.h"
*/
import "C"

import (
	"errors"
	"runtime"
	"runtime/cgo"
	"sync"
	"sync/atomic"
)

const supported = true

// Physical ANSI/ISO key positions, not typed characters or layout-dependent labels.
var macCodes = map[string]int{
	"KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9,
	"IntlBackslash": 10, "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
	"Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24, "Digit9": 25, "Digit7": 26,
	"Minus": 27, "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31, "KeyU": 32, "BracketLeft": 33, "KeyI": 34, "KeyP": 35,
	"Enter": 36, "KeyL": 37, "KeyJ": 38, "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44,
	"KeyN": 45, "KeyM": 46, "Period": 47, "Space": 49, "Backquote": 50, "Backspace": 51,
	"ShiftLeft": 56, "CapsLock": 57, "AltLeft": 58, "ControlLeft": 59, "ShiftRight": 60, "AltRight": 61, "ControlRight": 62,
	"NumpadDecimal": 65, "NumpadMultiply": 67, "NumpadAdd": 69, "NumLock": 71, "NumpadDivide": 75, "NumpadEnter": 76, "NumpadSubtract": 78,
	"Numpad0": 82, "Numpad1": 83, "Numpad2": 84, "Numpad3": 85, "Numpad4": 86, "Numpad5": 87, "Numpad6": 88, "Numpad7": 89, "Numpad8": 91, "Numpad9": 92,
	"F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101, "F11": 103, "F10": 109, "F12": 111,
	"Home": 115, "PageUp": 116, "Delete": 117, "F4": 118, "End": 119, "F2": 120, "PageDown": 121, "F1": 122,
	"ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
}

func Permission() PermissionStatus {
	granted := C.bc_input_permission() != 0
	detail := ""
	if !granted {
		detail = "Allow BetterComms in macOS System Settings → Privacy & Security → Input Monitoring, then restart BetterComms."
	}
	return PermissionStatus{Available: true, Granted: granted, Detail: detail}
}
func RequestPermission() PermissionStatus { C.bc_input_request_permission(); return Permission() }

func macInput(i input) (C.int, C.int, error) {
	if !i.keyboard {
		return -1, C.int([...]int{0, 2, 1, 3, 4}[i.button]), nil
	}
	for code, physical := range scanCode {
		if physical.scan == i.scan && physical.extended == i.extended {
			if key, ok := macCodes[code]; ok {
				return C.int(key), -1, nil
			}
		}
	}
	return -1, -1, ErrUnsupportedKey
}

type darwinSession struct {
	observed      *observed
	state         *shared
	options       Options
	keys, buttons []C.int
	changed       chan struct{}
	stopping      *atomic.Bool
}

//export bcInputEvent
func bcInputEvent(handle C.uintptr_t, index C.int, down C.int) {
	session := cgo.Handle(handle).Value().(*darwinSession)
	if int(index) >= 0 && int(index) < len(session.observed.watches) && session.observed.change(session.observed.watches[int(index)].input, down != 0) {
		select {
		case session.changed <- struct{}{}:
		default:
		}
	}
}

//export bcInputTick
func bcInputTick(handle C.uintptr_t) C.int {
	session := cgo.Handle(handle).Value().(*darwinSession)
	if session.stopping.Load() || session.state.expired() || !session.options.trusted() || C.bc_input_permission() == 0 {
		return 0
	}
	for i, watch := range session.observed.watches {
		if C.bc_input_down(session.keys[i], session.buttons[i]) == 0 && session.observed.change(watch.input, false) {
			select {
			case session.changed <- struct{}{}:
			default:
			}
		}
	}
	return 1
}

type worker struct {
	mu       sync.Mutex
	tap      *C.bc_input_tap
	done     chan struct{}
	stopping atomic.Bool
}

func (w *worker) stop() {
	w.stopping.Store(true)
	w.mu.Lock()
	if w.tap != nil {
		C.bc_input_stop(w.tap)
	}
	w.mu.Unlock()
	<-w.done
}

func startWorker(watches []watch, state *shared, options Options) (*worker, error) {
	if !Permission().Granted {
		return nil, errors.New(Permission().Detail)
	}
	session := &darwinSession{state: state, options: options, changed: make(chan struct{}, 1)}
	for _, watch := range watches {
		key, button, err := macInput(watch.input)
		if err != nil {
			return nil, err
		}
		session.keys = append(session.keys, key)
		session.buttons = append(session.buttons, button)
	}
	session.observed = newObserved(watches, func(i input) bool { key, button, _ := macInput(i); return C.bc_input_down(key, button) != 0 })
	w := &worker{done: make(chan struct{})}
	session.stopping = &w.stopping
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(w.done)
		handle := cgo.NewHandle(session)
		defer handle.Delete()
		tap := C.bc_input_create(C.uintptr_t(handle), &session.keys[0], &session.buttons[0], C.int(len(watches)))
		if tap == nil {
			ready <- errors.New("macOS could not register call shortcuts. Check Input Monitoring permission and restart BetterComms.")
			return
		}
		w.mu.Lock()
		w.tap = tap
		w.mu.Unlock()
		emitted := make(chan struct{})
		go func() {
			defer close(emitted)
			for range session.changed {
				session.observed.publish(state, options, true)
			}
		}()
		ready <- nil
		C.bc_input_run(tap)
		w.mu.Lock()
		w.tap = nil
		C.bc_input_destroy(tap)
		w.mu.Unlock()
		// Event publishing ends before the final unhealthy snapshot.
		close(session.changed)
		<-emitted
		session.observed.publish(state, options, false)
	}()
	if err := <-ready; err != nil {
		<-w.done
		return nil, err
	}
	return w, nil
}
