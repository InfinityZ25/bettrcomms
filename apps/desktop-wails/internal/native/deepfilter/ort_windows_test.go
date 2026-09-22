//go:build windows

package deepfilter

import (
	"math"
	"testing"
	"time"
)

func requireInstall(t *testing.T) {
	t.Helper()
	if _, err := resolveInstall(); err != nil {
		t.Skipf("the DeepFilterNet DirectML package is not installed here: %v", err)
	}
}

// speech is a frame of something periodic and non-silent, so the recurrent
// model is actually exercised rather than fed zeros.
func speech(offset int) []float32 {
	frame := make([]float32, FrameSamples)
	for index := range frame {
		position := float64(offset*FrameSamples + index)
		frame[index] = float32(math.Sin(position*0.071)*0.05 + math.Sin(position*0.013)*0.02)
	}
	return frame
}

// This is the acceptance test: the real ONNX Runtime, the real DirectML
// provider, the real model, on this machine's GPU.
func TestTheModelLoadsOnThisMachinesGPUAndDenoises(t *testing.T) {
	requireInstall(t)

	engine := NewEngine()
	t.Cleanup(engine.Close)

	if err := engine.Load(30); err != nil {
		t.Fatalf("Load: %v", err)
	}
	adapter := engine.Adapter()
	if adapter == "" {
		t.Error("the engine did not report which adapter it placed the graph on")
	}
	t.Logf("DeepFilterNet is running on %s", adapter)

	// Run enough frames that the recurrent state has to carry forward.
	var produced int
	for index := range 16 {
		out, err := engine.Process(speech(index))
		if err != nil {
			t.Fatalf("frame %d: %v", index, err)
		}
		if len(out) != FrameSamples {
			t.Fatalf("frame %d returned %d samples, want %d", index, len(out), FrameSamples)
		}
		for _, sample := range out {
			if math.IsNaN(float64(sample)) || math.IsInf(float64(sample), 0) {
				t.Fatalf("frame %d holds a non-finite sample", index)
			}
		}
		produced += len(out)
	}
	t.Logf("processed %d samples through the graph", produced)

	// The model has to actually change the signal. Output identical to input
	// would mean the graph ran but did nothing.
	input := speech(99)
	output, err := engine.Process(input)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	var difference float64
	for index := range output {
		difference += math.Abs(float64(output[index] - input[index]))
	}
	if difference == 0 {
		t.Error("the output is byte-identical to the input; the model did nothing")
	}
}

// A real-time filter has to keep up: 512 samples at 48 kHz is 10.7 ms of
// audio, and a frame that takes longer than that to process falls behind.
func TestProcessingKeepsUpWithRealTime(t *testing.T) {
	requireInstall(t)

	engine := NewEngine()
	t.Cleanup(engine.Close)
	if err := engine.Load(30); err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Warm up: the first frames pay for GPU kernel compilation.
	for index := range 8 {
		if _, err := engine.Process(speech(index)); err != nil {
			t.Fatalf("warm-up frame %d: %v", index, err)
		}
	}

	const measured = 48
	started := time.Now()
	for index := range measured {
		if _, err := engine.Process(speech(index)); err != nil {
			t.Fatalf("frame %d: %v", index, err)
		}
	}
	perFrame := time.Since(started) / measured
	// Integer arithmetic: the float form is a non-integer constant and will
	// not convert to a Duration.
	const realTime = time.Second * FrameSamples / SampleRate

	t.Logf("%v per frame against a %v budget (%.0f%% of real time)",
		perFrame.Round(time.Microsecond), realTime.Round(time.Microsecond),
		float64(perFrame)/float64(realTime)*100)

	if perFrame >= realTime {
		t.Errorf("processing takes %v per frame, past the %v real-time budget", perFrame, realTime)
	}
}

// Resetting must clear the recurrent state, so a new call does not begin with
// the tail of the previous one.
func TestResetClearsTheRecurrentState(t *testing.T) {
	requireInstall(t)

	engine := NewEngine()
	t.Cleanup(engine.Close)
	if err := engine.Load(30); err != nil {
		t.Fatalf("Load: %v", err)
	}

	first, err := engine.Process(speech(0))
	if err != nil {
		t.Fatalf("first frame: %v", err)
	}
	// Drive the state somewhere else.
	for index := 1; index < 12; index++ {
		if _, err := engine.Process(speech(index)); err != nil {
			t.Fatalf("frame %d: %v", index, err)
		}
	}
	if err := engine.Reset(); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	again, err := engine.Process(speech(0))
	if err != nil {
		t.Fatalf("after reset: %v", err)
	}

	// The same input from the same starting state must give the same output.
	for index := range first {
		if first[index] != again[index] {
			t.Fatalf("sample %d differs after reset (%v then %v); the state was not restored",
				index, first[index], again[index])
		}
	}
}

// The attenuation setting has to change what comes out, or the control does
// nothing.
func TestAttenuationChangesTheMix(t *testing.T) {
	requireInstall(t)

	gentle := NewEngine()
	t.Cleanup(gentle.Close)
	if err := gentle.Load(6); err != nil {
		t.Fatalf("Load: %v", err)
	}
	full := NewEngine()
	t.Cleanup(full.Close)
	if err := full.Load(100); err != nil {
		t.Fatalf("Load: %v", err)
	}

	frame := speech(3)
	gentleOut, err := gentle.Process(frame)
	if err != nil {
		t.Fatalf("gentle: %v", err)
	}
	fullOut, err := full.Process(frame)
	if err != nil {
		t.Fatalf("full: %v", err)
	}

	var difference float64
	for index := range gentleOut {
		difference += math.Abs(float64(gentleOut[index] - fullOut[index]))
	}
	if difference == 0 {
		t.Error("6 dB and 100 dB of attenuation produced identical output")
	}
}

func TestTheGraphContractIsVerified(t *testing.T) {
	requireInstall(t)

	engine := NewEngine()
	t.Cleanup(engine.Close)
	if err := engine.Load(30); err != nil {
		t.Fatalf("Load: %v", err)
	}

	engine.mu.Lock()
	inputs := append([]string(nil), engine.session.inputOrder...)
	outputs := append([]string(nil), engine.session.outputOrder...)
	engine.mu.Unlock()

	if len(inputs) != stateCount+1 || inputs[0] != inputName {
		t.Errorf("inputs = %v", inputs)
	}
	if len(outputs) != stateCount+1 {
		t.Errorf("outputs = %v", outputs)
	}
	// Every state's output must be the new value of the matching input.
	for index, name := range inputs[1:] {
		if outputs[index+1] != "new_"+name {
			t.Errorf("output %d is %q, want new_%s", index+1, outputs[index+1], name)
		}
	}
}

// Status must reflect the machine, not a guess.
func TestStatusReportsThisMachine(t *testing.T) {
	engine := NewEngine()
	t.Cleanup(engine.Close)

	status := engine.Status()
	if status.Detail == "" {
		t.Error("Status carries no explanation")
	}
	if _, err := resolveInstall(); err != nil {
		if status.Available {
			t.Error("Status reported available with no installation")
		}
		return
	}
	if !status.Installed {
		t.Error("an installed package was reported as absent")
	}
	if status.Available && status.Adapter == "" {
		t.Error("an available engine did not name its adapter")
	}
	t.Logf("status: available=%v adapter=%q detail=%s", status.Available, status.Adapter, status.Detail)
}
