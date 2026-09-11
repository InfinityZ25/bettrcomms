//go:build windows

package nativescreen

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"bettercomms/desktop-wails/internal/native/h264"
)

// requireRuntime skips when this machine has no FFmpeg runtime to capture with.
// Skipping is honest: the test proves nothing about capture without one.
func requireRuntime(t *testing.T) string {
	t.Helper()
	path, err := ffmpegPath()
	if err != nil {
		t.Skipf("no FFmpeg runtime on this machine: %v", err)
	}
	return path
}

// The probe must trial each encoder rather than read a capability list: a
// driver can advertise an encoder it then refuses to initialise, and finding
// that out when someone hits Share is too late.
func TestProbeTrialsEveryEncoderOnThisMachine(t *testing.T) {
	requireRuntime(t)

	capabilities := Probe(context.Background())
	if len(capabilities.Encoders) != len(knownEncoders) {
		t.Fatalf("probed %d encoders, want %d", len(capabilities.Encoders), len(knownEncoders))
	}

	var available []string
	for _, encoder := range capabilities.Encoders {
		if encoder.Reason == "" {
			t.Errorf("%s carries no reason", encoder.ID)
		}
		if encoder.Available {
			available = append(available, encoder.ID)
		}
		t.Logf("%-12s available=%-5v %s", encoder.ID, encoder.Available, encoder.Reason)
	}

	// libx264 is software and must work anywhere a runtime exists.
	var sawSoftware bool
	for _, id := range available {
		if id == "libx264" {
			sawSoftware = true
		}
	}
	if !sawSoftware {
		t.Error("the software encoder failed its probe, so no encoder is trustworthy here")
	}
	if !capabilities.Available {
		t.Error("capabilities report unavailable despite a working encoder")
	}
	t.Logf("available on this machine: %v", available)
}

func TestProbeReportsAMissingRuntime(t *testing.T) {
	// Point the fallback at an empty directory so no runtime is found.
	t.Setenv("LOCALAPPDATA", t.TempDir())
	if ffmpegsetupRuntimePresent() {
		t.Skip("an installed runtime is present, so the missing-runtime path cannot be exercised")
	}

	capabilities := Probe(context.Background())
	if capabilities.Available {
		t.Error("capabilities report available with no runtime")
	}
	if !strings.Contains(capabilities.Detail, "Install native sharing runtime") {
		t.Errorf("detail = %q, want the instruction the picker offers", capabilities.Detail)
	}
}

// ffmpegsetupRuntimePresent reports whether a bundled runtime short-circuits
// the LOCALAPPDATA fallback.
func ffmpegsetupRuntimePresent() bool {
	path, err := ffmpegPath()
	return err == nil && path != ""
}

// This is the acceptance test for native screen sharing: Windows Graphics
// Capture through the real FFmpeg runtime, into the real H.264 encoder, out as
// access units the WebRTC hub accepts.
func TestACaptureOfThisDisplayProducesH264AccessUnits(t *testing.T) {
	requireRuntime(t)

	capabilities := Probe(context.Background())
	encoder := ""
	for _, candidate := range capabilities.Encoders {
		if candidate.Available {
			encoder = candidate.ID
			break
		}
	}
	if encoder == "" {
		t.Skip("no encoder passed its probe on this machine")
	}

	manager := NewManager()
	t.Cleanup(manager.Close)

	sources, err := manager.Sources()
	if err != nil {
		t.Fatalf("Sources: %v", err)
	}
	var display Source
	for _, source := range sources {
		if source.Kind == "monitor" {
			display = source
			break
		}
	}
	if display.ID == "" {
		t.Skip("no display to capture")
	}

	started, err := manager.Start(context.Background(), StartOptions{
		SourceID:    display.ID,
		Encoder:     encoder,
		Width:       640,
		Height:      360,
		FPS:         15,
		BitrateMbps: 2,
		H264Profile: h264.Baseline,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Logf("capturing %s with %s at %dx%d", display.Name, started.Encoder, started.Width, started.Height)

	if started.Width > 640 || started.Height > 360 {
		t.Errorf("capture is %dx%d, larger than the ceiling asked for", started.Width, started.Height)
	}

	hub, err := manager.Hub(started.SessionID)
	if err != nil {
		t.Fatalf("Hub: %v", err)
	}

	// Give the capture a few seconds to produce frames.
	deadline := time.Now().Add(25 * time.Second)
	var stats = hub.Stats()
	for time.Now().Before(deadline) && stats.AccessUnits < 5 {
		time.Sleep(200 * time.Millisecond)
		stats = hub.Stats()
	}

	if stats.AccessUnits < 5 {
		_, detail, _ := manager.Diagnostics(started.SessionID)
		t.Fatalf("only %d access units after 25s; encoder said: %s", stats.AccessUnits, detail)
	}
	if stats.Keyframes == 0 {
		t.Error("no keyframe was produced, so no viewer could ever start")
	}
	if stats.EncodedBytes == 0 {
		t.Error("access units were counted but carried no bytes")
	}
	// The encoder must have honoured the profile it was given: 0x42 is
	// baseline's profile_idc.
	if stats.SPSProfileIDC != "42" {
		t.Errorf("stream profile_idc = %q, want 42 for baseline", stats.SPSProfileIDC)
	}
	t.Logf("produced %d access units (%d keyframes, %d bytes), SPS %s%s%s",
		stats.AccessUnits, stats.Keyframes, stats.EncodedBytes,
		stats.SPSProfileIDC, stats.SPSConstraintFlags, stats.SPSLevelIDC)

	if err := manager.Stop(started.SessionID); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := manager.Hub(started.SessionID); err == nil {
		t.Error("the hub is still reachable after the capture stopped")
	}
}

// Only one capture runs at a time: two encoders on one display would double
// the cost for no benefit.
func TestOnlyOneCaptureRunsAtATime(t *testing.T) {
	requireRuntime(t)

	capabilities := Probe(context.Background())
	encoder := ""
	for _, candidate := range capabilities.Encoders {
		if candidate.Available {
			encoder = candidate.ID
			break
		}
	}
	if encoder == "" {
		t.Skip("no encoder passed its probe on this machine")
	}

	manager := NewManager()
	t.Cleanup(manager.Close)

	sources, err := manager.Sources()
	if err != nil {
		t.Fatalf("Sources: %v", err)
	}
	var display Source
	for _, source := range sources {
		if source.Kind == "monitor" {
			display = source
			break
		}
	}
	if display.ID == "" {
		t.Skip("no display to capture")
	}

	options := StartOptions{
		SourceID: display.ID, Encoder: encoder,
		Width: 640, Height: 360, FPS: 15, BitrateMbps: 2,
	}
	started, err := manager.Start(context.Background(), options)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := manager.Start(context.Background(), options); err == nil {
		t.Error("a second capture started while one was running")
	}
	if err := manager.Stop(started.SessionID); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	// Stopping frees the slot.
	if _, err := manager.Start(context.Background(), options); err != nil {
		t.Errorf("a capture could not start after the previous one stopped: %v", err)
	}
}

func TestStartRejectsWhatItCannotCapture(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Close)

	// Settings are checked before anything is spawned.
	if _, err := manager.Start(context.Background(), StartOptions{
		SourceID: "whatever", Encoder: "libx264",
		Width: 640, Height: 360, FPS: 1, BitrateMbps: 2,
	}); !errors.Is(err, ErrCaptureSettings) {
		t.Errorf("err = %v, want ErrCaptureSettings", err)
	}

	// An unknown source is refused with the instruction that fixes it.
	if _, err := manager.Start(context.Background(), StartOptions{
		SourceID: "never-enumerated", Encoder: "libx264",
		Width: 640, Height: 360, FPS: 15, BitrateMbps: 2,
	}); err == nil {
		t.Error("an unknown source id was accepted")
	}
}

func TestStopAndDiagnosticsTolerateAnUnknownSession(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Close)

	if err := manager.Stop("never-started"); err != nil {
		t.Errorf("Stop: %v", err)
	}
	if _, _, err := manager.Diagnostics("never-started"); err == nil {
		t.Error("diagnostics for an unknown session succeeded")
	}
}
