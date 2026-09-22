package main

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"bettercomms/desktop-wails/internal/desktop"
)

// No native managers are initialised: touching a device, file or session before
// authorisation would panic, rather than accidentally making this test pass.
func TestSensitiveNativeMethodsRejectUnauthorisedPages(t *testing.T) {
	gate, err := desktop.NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	service := &NativeMediaService{gate: gate}
	methods := []string{
		"FfmpegInstall", "NativeScreenSources", "NativeScreenThumbnail", "NativeScreenStart", "NativeScreenStop", "NativeScreenDiagnostics",
		"NativeScreenPeerOffer", "NativeScreenPeerAnswer", "NativeScreenPeerCandidate", "NativeScreenPeerRemove",
		"NativeScreenRecordingStart", "NativeScreenRecordingStop", "NativeScreenRecordingRead", "NativeScreenRecordingRelease",
		"PushToTalkStart", "PushToTalkHeartbeat", "PushToTalkStop", "RecordingExportBegin", "RecordingConversionBegin",
		"RecordingExportAppend", "RecordingExportFinish", "RecordingExportAbort", "CameraOverlayOpen", "CameraOverlayUpdate",
		"CameraOverlayFrame", "CameraOverlayClose", "CopilotOverlayFrame", "CopilotOverlayClear", "NativeSystemAudioStart",
		"NativeSystemAudioRead", "NativeSystemAudioStop", "NvidiaInstall", "DeepfilterInstall", "NvidiaStatus", "DeepfilterStatus",
		"AudioStreamStart", "AudioStreamStop", "MediaPermissionOpenSettings",
	}
	for _, name := range methods {
		t.Run(name, func(t *testing.T) {
			method := reflect.ValueOf(service).MethodByName(name)
			if !method.IsValid() {
				t.Fatal("required native method missing")
			}
			args := make([]reflect.Value, method.Type().NumIn())
			for i := range args {
				typ := method.Type().In(i)
				if typ == reflect.TypeFor[context.Context]() {
					args[i] = reflect.ValueOf(context.Background())
				} else {
					args[i] = reflect.Zero(typ)
				}
			}
			results := method.Call(args)
			last := results[len(results)-1].Interface()
			failure, ok := last.(error)
			if !ok || !errors.Is(failure, desktop.ErrUntrustedCaller) {
				t.Fatalf("method did not reject unauthorised caller: %v", last)
			}
		})
	}
}
