package main

import (
	"testing"
	"time"

	"bettercomms/desktop-wails/internal/native/pushtotalk"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

func TestCallInputFocusUsesEventsAndClosesWithoutQueryingTheWindow(t *testing.T) {
	service := &NativeMediaService{window: &application.WebviewWindow{}}
	callbacks := map[events.WindowEventType]func(*application.WindowEvent){}
	removed := 0
	service.inputFocus.attach(func(kind events.WindowEventType, callback func(*application.WindowEvent)) func() {
		callbacks[kind] = callback
		return func() { removed++ }
	})
	callbacks[events.Common.WindowFocus](nil)
	if !service.inputOptions().Focused() {
		t.Fatal("focus did not use the event cache")
	}
	callbacks[events.Common.WindowLostFocus](nil)
	if service.inputOptions().Focused() {
		t.Fatal("lost focus was not cached")
	}
	callbacks[events.Common.WindowFocus](nil)
	service.inputFocus.close()
	// A focus notification that was already queued cannot revive a closing host.
	callbacks[events.Common.WindowFocus](nil)
	service.inputFocus.close()
	if service.inputOptions().Focused() || service.inputOptions().Trusted() || removed != 2 {
		t.Fatalf("closing input still active or listeners leaked: %d", removed)
	}
}

func TestCallInputWorkerCloseDoesNotWaitForAWindowOnTheUIThread(t *testing.T) {
	if !pushtotalk.Describe().Available {
		t.Skip("native input registration unavailable on this test host")
	}
	service := &NativeMediaService{talk: pushtotalk.NewManager()}
	t.Cleanup(service.talk.Close)
	service.inputFocus.focused.Store(true)
	if _, err := service.talk.Start(pushtotalk.Binding{Kind: pushtotalk.KindKeyboard, Code: "F12"}, pushtotalk.Options{
		Focused: service.inputOptions().Focused,
	}); err != nil {
		t.Fatal(err)
	}
	service.inputFocus.close()
	done := make(chan struct{})
	go func() { service.talk.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("worker close waited for the UI thread")
	}
}
