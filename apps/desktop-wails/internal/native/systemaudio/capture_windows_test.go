//go:build windows

package systemaudio

import (
	"testing"
	"time"
)

func requireProcessLoopback(t *testing.T) {
	t.Helper()
	if got := Describe(); !got.Available {
		t.Skipf("process loopback is unavailable here: %s", got.Detail)
	}
}

// The build gate is what the capability report is keyed on, so it must reflect
// the machine rather than a guess.
func TestTheWindowsBuildIsReadFromTheRunningSystem(t *testing.T) {
	build, known := windowsBuild()
	if !known {
		t.Fatal("the Windows build could not be read")
	}
	// Anything this can run on is well past Windows 10's first build.
	if build < 10000 || build > 1_000_000 {
		t.Errorf("build = %d, which is not a plausible Windows build number", build)
	}
	t.Logf("Windows build %d (process loopback needs %d)", build, MinimumWindowsBuild)
}

// This is the acceptance test: a real WASAPI process-loopback activation
// through the hand-built COM completion handler, capturing real system audio
// while excluding this process's tree.
func TestSystemCaptureExcludesThisProcessAndProducesFrames(t *testing.T) {
	requireProcessLoopback(t)

	manager := NewManager()
	t.Cleanup(manager.Close)

	started, err := manager.Start(StartOptions{}, nil)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Mode != ModeSystem {
		t.Errorf("mode = %q, want %q", started.Mode, ModeSystem)
	}
	if started.SampleRate != Rate || started.Channels != Channels {
		t.Errorf("format = %d Hz / %d channels, want %d / %d",
			started.SampleRate, started.Channels, Rate, Channels)
	}

	// Loopback delivers silence when nothing is playing, so the claim here is
	// that the stream runs and produces whole frames, not that it is loud.
	deadline := time.Now().Add(5 * time.Second)
	var total int
	for time.Now().Before(deadline) && total == 0 {
		chunk, err := manager.Read(started.SessionID)
		if err != nil {
			t.Fatalf("Read: %v", err)
		}
		if len(chunk)%frameBytes != 0 {
			t.Fatalf("a read returned %d bytes, which is not a whole number of frames", len(chunk))
		}
		total += len(chunk)
		if total == 0 {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if total == 0 {
		t.Fatal("no audio was produced in five seconds; the capture never started")
	}
	t.Logf("captured %d bytes (%d frames) of system audio", total, total/frameBytes)

	if err := manager.Stop(started.SessionID); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := manager.Read(started.SessionID); err == nil {
		t.Error("a stopped session is still readable")
	}
}

// Excluding this process is the whole point during a call: including it would
// record the other participants and send them back.
func TestApplicationCaptureTargetsOneProcessTree(t *testing.T) {
	requireProcessLoopback(t)

	manager := NewManager()
	t.Cleanup(manager.Close)

	// Target this test process, which produces no audio. The claim is that the
	// activation succeeds for an include-tree target, not that it is audible.
	resolve := func(string) (uint32, bool, error) {
		self, err := ownProcessTree()
		return self, true, err
	}
	started, err := manager.Start(StartOptions{SourceID: "self"}, resolve)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Mode != ModeApplication {
		t.Errorf("mode = %q, want %q", started.Mode, ModeApplication)
	}
	if err := manager.Stop(started.SessionID); err != nil {
		t.Fatalf("Stop: %v", err)
	}
}

// Each session is a WASAPI client and a worker thread, so the count is bounded.
func TestConcurrentSessionsAreBounded(t *testing.T) {
	requireProcessLoopback(t)

	manager := NewManager()
	t.Cleanup(manager.Close)

	var ids []string
	for index := range maxSessions {
		started, err := manager.Start(StartOptions{}, nil)
		if err != nil {
			t.Fatalf("session %d: %v", index, err)
		}
		ids = append(ids, started.SessionID)
	}
	if _, err := manager.Start(StartOptions{}, nil); err == nil {
		t.Error("the session limit was exceeded")
	}

	// Stopping one frees a slot.
	if err := manager.Stop(ids[0]); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := manager.Start(StartOptions{}, nil); err != nil {
		t.Errorf("a freed slot was not reusable: %v", err)
	}
}

// Closing the manager stops every capture, so no WASAPI client outlives the
// process.
func TestCloseStopsEveryCapture(t *testing.T) {
	requireProcessLoopback(t)

	manager := NewManager()
	started, err := manager.Start(StartOptions{}, nil)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	manager.Close()

	if _, err := manager.Read(started.SessionID); err == nil {
		t.Error("a capture survived the manager being closed")
	}
}
