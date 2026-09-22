package systemaudio

import (
	"bytes"
	"errors"
	"testing"
)

// The ring drops the oldest audio rather than blocking: WASAPI will not wait
// for a slow reader, and a late reader wants the newest audio anyway.
func TestTheRingDropsTheOldestAudioWhenItIsFull(t *testing.T) {
	buffer := &ring{}

	// Overfill it by a quarter.
	chunk := bytes.Repeat([]byte{1}, frameBytes*1000)
	for range (ringBytes / len(chunk)) + 2 {
		buffer.append(chunk)
	}

	buffer.mu.Lock()
	held := len(buffer.buffer)
	buffer.mu.Unlock()

	if held > ringBytes {
		t.Errorf("the ring holds %d bytes, past its %d limit", held, ringBytes)
	}
	if held%frameBytes != 0 {
		t.Errorf("the ring holds %d bytes, which is not a whole number of frames", held)
	}
}

// A reader never sees a split sample.
func TestTheRingOnlyAcceptsWholeFrames(t *testing.T) {
	buffer := &ring{}

	buffer.append(make([]byte, frameBytes+3))
	buffer.mu.Lock()
	held := len(buffer.buffer)
	buffer.mu.Unlock()
	if held != frameBytes {
		t.Errorf("held %d bytes, want one whole frame of %d", held, frameBytes)
	}

	// A partial frame on its own contributes nothing.
	buffer.append(make([]byte, frameBytes-1))
	buffer.mu.Lock()
	held = len(buffer.buffer)
	buffer.mu.Unlock()
	if held != frameBytes {
		t.Errorf("a partial frame was stored: %d bytes", held)
	}
}

// A reader that fell behind gets the newest audio, not a backlog. Stale audio
// played late is worse than a gap.
func TestReadingDiscardsABacklogAndReturnsTheNewest(t *testing.T) {
	buffer := &ring{}

	// Fill with a recognisable sequence: the last block is all 0xFF.
	old := bytes.Repeat([]byte{0x11}, readBytes*2)
	newest := bytes.Repeat([]byte{0xFF}, readBytes)
	buffer.append(old)
	buffer.append(newest)

	got := buffer.take()
	if len(got) != readBytes {
		t.Fatalf("read %d bytes, want %d", len(got), readBytes)
	}
	for index, value := range got {
		if value != 0xFF {
			t.Fatalf("byte %d is %#x; stale audio was replayed", index, value)
		}
	}
}

func TestReadingAnEmptyRingReturnsNothing(t *testing.T) {
	buffer := &ring{}
	if got := buffer.take(); len(got) != 0 {
		t.Errorf("read %d bytes from an empty ring", len(got))
	}
}

func TestReadingReturnsWholeFramesAndDrainsThem(t *testing.T) {
	buffer := &ring{}
	buffer.append(bytes.Repeat([]byte{7}, frameBytes*10))

	got := buffer.take()
	if len(got) != frameBytes*10 {
		t.Errorf("read %d bytes, want %d", len(got), frameBytes*10)
	}
	if len(buffer.take()) != 0 {
		t.Error("the ring still holds audio after being drained")
	}
}

// The default is to exclude this application, because including it in a call
// means recording the other participants and sending them back.
func TestTheDefaultExcludesThisApplication(t *testing.T) {
	manager := NewManager()
	manager.selfProcess = func() (uint32, error) { return 4242, nil }

	selected, err := manager.resolveTarget(StartOptions{}, nil)
	if err != nil {
		t.Fatalf("resolveTarget: %v", err)
	}
	if selected.mode != ModeSystem {
		t.Errorf("mode = %q, want %q", selected.mode, ModeSystem)
	}
	if selected.processID != 4242 {
		t.Errorf("excluded process = %d, want this application's 4242", selected.processID)
	}
}

// Turning exclusion off is the only way to record this application, and it has
// to be explicit.
func TestWholeSystemRequiresTurningExclusionOff(t *testing.T) {
	manager := NewManager()
	manager.selfProcess = func() (uint32, error) { return 1, nil }

	off := false
	selected, err := manager.resolveTarget(StartOptions{ExcludeCallAudio: &off}, nil)
	if err != nil {
		t.Fatalf("resolveTarget: %v", err)
	}
	if selected.mode != ModeWholeSystem {
		t.Errorf("mode = %q, want %q", selected.mode, ModeWholeSystem)
	}

	// Explicitly on is the same as absent.
	on := true
	selected, err = manager.resolveTarget(StartOptions{ExcludeCallAudio: &on}, nil)
	if err != nil {
		t.Fatalf("resolveTarget: %v", err)
	}
	if selected.mode != ModeSystem {
		t.Errorf("mode = %q, want %q", selected.mode, ModeSystem)
	}
}

// A window source captures that application's tree. The page names a source
// id; this package never sees a process id it did not resolve.
func TestAWindowSourceCapturesThatApplication(t *testing.T) {
	manager := NewManager()
	manager.selfProcess = func() (uint32, error) { return 1, nil }

	resolve := func(sourceID string) (uint32, bool, error) {
		if sourceID != "source-1" {
			t.Errorf("resolver saw %q", sourceID)
		}
		return 9001, true, nil
	}
	selected, err := manager.resolveTarget(StartOptions{SourceID: "source-1"}, resolve)
	if err != nil {
		t.Fatalf("resolveTarget: %v", err)
	}
	if selected.mode != ModeApplication {
		t.Errorf("mode = %q, want %q", selected.mode, ModeApplication)
	}
	if selected.processID != 9001 {
		t.Errorf("target = %d, want the resolved 9001", selected.processID)
	}
}

// A display has no owning process, so it falls through to system audio rather
// than failing.
func TestADisplaySourceFallsBackToSystemAudio(t *testing.T) {
	manager := NewManager()
	manager.selfProcess = func() (uint32, error) { return 77, nil }

	resolve := func(string) (uint32, bool, error) { return 0, false, nil }
	selected, err := manager.resolveTarget(StartOptions{SourceID: "display-1"}, resolve)
	if err != nil {
		t.Fatalf("resolveTarget: %v", err)
	}
	if selected.mode != ModeSystem || selected.processID != 77 {
		t.Errorf("selected = %+v, want system audio excluding this application", selected)
	}
}

// A source the host cannot resolve must fail rather than silently capturing
// something else.
func TestAnUnresolvableSourceFails(t *testing.T) {
	manager := NewManager()
	manager.selfProcess = func() (uint32, error) { return 1, nil }

	resolve := func(string) (uint32, bool, error) {
		return 0, false, errors.New("Refresh screen sources before sharing application audio")
	}
	if _, err := manager.resolveTarget(StartOptions{SourceID: "gone"}, resolve); err == nil {
		t.Error("an unresolvable source was accepted")
	}
	// With no resolver at all, an application capture is refused.
	if _, err := manager.resolveTarget(StartOptions{SourceID: "any"}, nil); err == nil {
		t.Error("an application capture was accepted with no resolver")
	}
}

func TestDescribeReportsTheBuildRequirement(t *testing.T) {
	got := Describe()
	if got.MinimumWindowsBuild != MinimumWindowsBuild {
		t.Errorf("minimum build = %d, want %d", got.MinimumWindowsBuild, MinimumWindowsBuild)
	}
	if got.Detail == "" {
		t.Error("Describe carries no explanation")
	}
	// Application audio and call-audio control come from the same mechanism, so
	// they cannot disagree.
	if got.ApplicationAudio != got.Available || got.CallAudioControl != got.Available {
		t.Errorf("capabilities disagree: %+v", got)
	}
}

func TestReadAndStopTolerateAnUnknownSession(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Close)

	if _, err := manager.Read("never-started"); err == nil {
		t.Error("reading an unknown session succeeded")
	}
	// Stopping what is not running succeeds: the goal is that it is not.
	if err := manager.Stop("never-started"); err != nil {
		t.Errorf("Stop: %v", err)
	}
}

func TestSessionIDsAreUniqueAndOpaque(t *testing.T) {
	first, err := newSessionID()
	if err != nil {
		t.Fatalf("newSessionID: %v", err)
	}
	second, err := newSessionID()
	if err != nil {
		t.Fatalf("newSessionID: %v", err)
	}
	if first == second || len(first) != 32 {
		t.Errorf("ids are %q and %q", first, second)
	}
}
