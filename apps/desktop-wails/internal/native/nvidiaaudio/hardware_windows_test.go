//go:build windows

package nvidiaaudio

import (
	"math"
	"testing"
	"time"
)

// The hardware acceptance test for NVIDIA Audio Effects.
//
// Nothing in this file runs without an NVIDIA Ada GPU and the pinned package
// installed, and it skips with the reason rather than failing: this workspace
// has neither, and a red test on a machine that was never going to run it says
// nothing. On a machine that does have both, `go test ./internal/native/nvidiaaudio/`
// is the whole procedure, and what it prints is the evidence.
//
// Until one of these has been seen to pass, the capability report must not
// claim the denoiser works. See internal/desktop/capabilities.go.

// requireEngine skips unless this machine can actually run the denoiser, and
// says which half is missing.
func requireEngine(t *testing.T) *Engine {
	t.Helper()

	info := Describe()
	if !info.Installed {
		root, _ := InstallRoot()
		t.Skipf("NVIDIA Audio Effects is not installed here (%s). Unpack the pinned package into %s, or point BETTERCOMMS_REPO at a checkout with .local/nvidia-audio-effects.",
			info.Detail, root)
	}
	if !info.Supported {
		t.Skipf("this machine cannot run the pinned package: %s", info.Detail)
	}

	engine := NewEngine()
	t.Cleanup(engine.Close)
	status := engine.Status()
	if !status.Available {
		t.Skipf("the SDK is installed but did not load a model here: %s", status.Detail)
	}
	t.Logf("NVIDIA Audio Effects is running on %s, %d samples per frame", info.GPUName, status.FrameSamples)
	return engine
}

// speech is a periodic, non-silent frame, so the denoiser is given something to
// work on rather than zeros.
func speech(frameSamples uint32, offset int) []float32 {
	frame := make([]float32, frameSamples)
	for index := range frame {
		position := float64(offset*int(frameSamples) + index)
		frame[index] = float32(math.Sin(position*0.071)*0.05 + math.Sin(position*0.013)*0.02)
	}
	return frame
}

// This is the acceptance test: the real SDK, the real model, on this machine's
// GPU, changing real audio.
func TestTheDenoiserLoadsOnThisMachinesGPUAndChangesTheSignal(t *testing.T) {
	engine := requireEngine(t)

	frameSamples, err := engine.Start(0.75, false)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if frameSamples == 0 || frameSamples > MaxFrameSamples {
		t.Fatalf("the model reported %d samples per frame, want 1 to %d", frameSamples, MaxFrameSamples)
	}

	// Enough frames that any internal state has to carry forward.
	for index := range 16 {
		out, err := engine.Process(speech(frameSamples, index))
		if err != nil {
			t.Fatalf("frame %d: %v", index, err)
		}
		if uint32(len(out)) != frameSamples {
			t.Fatalf("frame %d returned %d samples, want %d", index, len(out), frameSamples)
		}
		for _, sample := range out {
			if math.IsNaN(float64(sample)) || math.IsInf(float64(sample), 0) {
				t.Fatalf("frame %d holds a non-finite sample", index)
			}
		}
	}

	// Output identical to input would mean the effect ran and did nothing.
	input := speech(frameSamples, 99)
	output, err := engine.Process(input)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	var difference float64
	for index := range output {
		difference += math.Abs(float64(output[index] - input[index]))
	}
	if difference == 0 {
		t.Error("the output is identical to the input; the effect did nothing")
	}
}

// A denoiser that cannot keep up with real time is not usable in a call.
func TestTheDenoiserKeepsUpWithRealTime(t *testing.T) {
	engine := requireEngine(t)

	frameSamples, err := engine.Start(0.75, false)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// The first frames pay for kernel compilation and are not the steady state.
	for index := range 8 {
		if _, err := engine.Process(speech(frameSamples, index)); err != nil {
			t.Fatalf("warm-up frame %d: %v", index, err)
		}
	}

	const measured = 48
	started := time.Now()
	for index := range measured {
		if _, err := engine.Process(speech(frameSamples, index)); err != nil {
			t.Fatalf("frame %d: %v", index, err)
		}
	}
	perFrame := time.Since(started) / measured
	// Integer arithmetic: the float form is a non-integer constant and will not
	// convert to a Duration.
	realTime := time.Second * time.Duration(frameSamples) / SampleRate

	t.Logf("%v per frame against a %v budget (%.0f%% of real time)",
		perFrame.Round(time.Microsecond), realTime.Round(time.Microsecond),
		float64(perFrame)/float64(realTime)*100)

	if perFrame >= realTime {
		t.Errorf("processing takes %v per frame, past the %v real-time budget", perFrame, realTime)
	}
}

// Intensity has to change what comes out, or the control does nothing.
func TestIntensityChangesTheMix(t *testing.T) {
	engine := requireEngine(t)

	frameSamples, err := engine.Start(0.1, false)
	if err != nil {
		t.Fatalf("Start gentle: %v", err)
	}
	frame := speech(frameSamples, 3)
	gentle, err := engine.Process(frame)
	if err != nil {
		t.Fatalf("gentle: %v", err)
	}
	gentle = append([]float32(nil), gentle...)

	if _, err := engine.Start(1, false); err != nil {
		t.Fatalf("Start full: %v", err)
	}
	full, err := engine.Process(frame)
	if err != nil {
		t.Fatalf("full: %v", err)
	}

	var difference float64
	for index := range gentle {
		difference += math.Abs(float64(gentle[index] - full[index]))
	}
	if difference == 0 {
		t.Error("0.1 and 1.0 intensity produced identical output")
	}
}

// Voice activity detection is a different effect configuration, and has to load
// as well as the denoiser alone.
func TestVoiceActivityDetectionLoads(t *testing.T) {
	engine := requireEngine(t)

	frameSamples, err := engine.Start(0.75, true)
	if err != nil {
		t.Fatalf("Start with VAD: %v", err)
	}
	if _, err := engine.Process(speech(frameSamples, 0)); err != nil {
		t.Errorf("Process with VAD: %v", err)
	}
}

// Turning the denoiser off and on again must not need a new GPU context, and
// must leave the engine usable.
func TestStoppingAndStartingAgainWorks(t *testing.T) {
	engine := requireEngine(t)

	if _, err := engine.Start(0.5, false); err != nil {
		t.Fatalf("Start: %v", err)
	}
	engine.Stop()
	if _, err := engine.Process(make([]float32, MaxFrameSamples)); err == nil {
		t.Error("a stopped engine processed a frame")
	}

	frameSamples, err := engine.Start(0.5, false)
	if err != nil {
		t.Fatalf("restart: %v", err)
	}
	if _, err := engine.Process(speech(frameSamples, 0)); err != nil {
		t.Errorf("Process after restart: %v", err)
	}
}
