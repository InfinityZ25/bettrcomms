package main

import (
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Native observers must never wait for the UI thread, including while Wails
// shuts services down on that thread. Official window events own this cache.
type callInputFocus struct {
	focused     atomic.Bool
	closed      atomic.Bool
	unsubscribe []func()
}

func (f *callInputFocus) attach(on func(events.WindowEventType, func(*application.WindowEvent)) func()) {
	f.unsubscribe = []func(){
		on(events.Common.WindowFocus, func(*application.WindowEvent) {
			if !f.closed.Load() {
				f.focused.Store(true)
			}
		}),
		on(events.Common.WindowLostFocus, func(*application.WindowEvent) { f.focused.Store(false) }),
	}
}
func (f *callInputFocus) isFocused() bool { return !f.closed.Load() && f.focused.Load() }
func (f *callInputFocus) close() {
	if f.closed.Swap(true) {
		return
	}
	f.focused.Store(false)
	for _, stop := range f.unsubscribe {
		stop()
	}
	f.unsubscribe = nil
}
