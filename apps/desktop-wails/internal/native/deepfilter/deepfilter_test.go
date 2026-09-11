package deepfilter

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDryMixFollowsTheAttenuation(t *testing.T) {
	// Full attenuation keeps none of the original.
	if mix, err := dryMixFor(100); err != nil || mix != 0 {
		t.Errorf("100 dB gave mix %v, err %v; want 0", mix, err)
	}
	// No attenuation keeps all of it.
	if mix, err := dryMixFor(0); err != nil || mix != 1 {
		t.Errorf("0 dB gave mix %v, err %v; want 1", mix, err)
	}
	// 20 dB is a tenth.
	mix, err := dryMixFor(20)
	if err != nil {
		t.Fatalf("dryMixFor: %v", err)
	}
	if math.Abs(float64(mix)-0.1) > 1e-6 {
		t.Errorf("20 dB gave mix %v, want 0.1", mix)
	}
	// More attenuation must never keep more of the original.
	previous := float32(2)
	for db := float32(0); db <= 100; db += 10 {
		mix, err := dryMixFor(db)
		if err != nil {
			t.Fatalf("dryMixFor(%v): %v", db, err)
		}
		if mix > previous {
			t.Errorf("%v dB kept more dry signal than %v dB", db, db-10)
		}
		previous = mix
	}
}

func TestAttenuationIsBounded(t *testing.T) {
	for _, invalid := range []float32{-1, 101, float32(math.Inf(1)), float32(math.NaN())} {
		if _, err := dryMixFor(invalid); err == nil {
			t.Errorf("%v was accepted", invalid)
		}
	}
}

// The delay line is what lines the dry signal up with the model's output. A
// wrong delay makes the mix sound like a short echo.
func TestTheDelayLineHoldsExactlyTheModelDelay(t *testing.T) {
	line := newDelayLine()

	// Everything read out before modelDelay samples have gone in is silence.
	for index := range modelDelay {
		if got := line.push(float32(index + 1)); got != 0 {
			t.Fatalf("sample %d came back as %v before the line filled", index, got)
		}
	}
	// After that, what comes out is what went in modelDelay samples ago.
	for index := range 64 {
		want := float32(index + 1)
		if got := line.push(0); got != want {
			t.Fatalf("delayed sample = %v, want %v", got, want)
		}
	}
}

func TestResettingTheDelayLineClearsIt(t *testing.T) {
	line := newDelayLine()
	for index := range modelDelay {
		line.push(float32(index + 1))
	}
	line.reset()
	for range modelDelay {
		if got := line.push(0); got != 0 {
			t.Fatalf("a reset line returned %v", got)
		}
	}
}

func TestFrameValidationBoundsWhatReachesTheModel(t *testing.T) {
	good := make([]float32, FrameSamples)
	if err := validateFrame(good, "input"); err != nil {
		t.Errorf("a valid frame was rejected: %v", err)
	}
	for _, test := range []struct {
		name  string
		frame []float32
	}{
		{"too short", make([]float32, FrameSamples-1)},
		{"too long", make([]float32, FrameSamples+1)},
		{"empty", nil},
	} {
		if err := validateFrame(test.frame, "input"); err == nil {
			t.Errorf("%s was accepted", test.name)
		}
	}

	for _, bad := range []float32{float32(math.NaN()), float32(math.Inf(1)), float32(math.Inf(-1)), 9, -9} {
		frame := make([]float32, FrameSamples)
		frame[17] = bad
		if err := validateFrame(frame, "input"); err == nil {
			t.Errorf("a frame holding %v was accepted", bad)
		}
	}
}

func writeInstall(t *testing.T, manifest map[string]any, files map[string]string) string {
	t.Helper()
	local := t.TempDir()
	root := filepath.Join(local, "Bettercomms", "deepfilter-directml")
	for name, body := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if manifest != nil {
		body, err := json.Marshal(manifest)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(root, "setup.json"), body, 0o644); err != nil {
			t.Fatalf("write manifest: %v", err)
		}
	}
	t.Setenv("LOCALAPPDATA", local)
	return root
}

func completeManifest() map[string]any {
	return map[string]any{
		"schemaVersion":     1,
		"runtimeDll":        "runtime/onnxruntime.dll",
		"providerSharedDll": "runtime/onnxruntime_providers_shared.dll",
		"directmlDll":       "runtime/DirectML.dll",
		"model":             "models/denoiser_model.onnx",
		"initialStates":     "models/initial_states.json",
		"sampleRate":        SampleRate,
		"frameSamples":      FrameSamples,
	}
}

func completeFiles() map[string]string {
	return map[string]string{
		"runtime/onnxruntime.dll":                  "dll",
		"runtime/onnxruntime_providers_shared.dll": "dll",
		"runtime/DirectML.dll":                     "dll",
		"models/denoiser_model.onnx":               "model",
		"models/initial_states.json":               "{}",
	}
}

func TestResolveInstallVerifiesEveryPath(t *testing.T) {
	writeInstall(t, completeManifest(), completeFiles())
	if _, err := resolveInstall(); err != nil {
		t.Fatalf("a complete install was rejected: %v", err)
	}
}

func TestResolveInstallRefusesEscapingPaths(t *testing.T) {
	for _, test := range []struct{ name, field, value string }{
		{"a runtime traversal", "runtimeDll", "../../evil.dll"},
		{"an absolute DirectML path", "directmlDll", "/windows/system32/evil.dll"},
		{"a model traversal", "model", "models/../../evil.onnx"},
	} {
		t.Run(test.name, func(t *testing.T) {
			manifest := completeManifest()
			manifest[test.field] = test.value
			writeInstall(t, manifest, completeFiles())
			if _, err := resolveInstall(); err == nil {
				t.Errorf("%s = %q was accepted", test.field, test.value)
			}
		})
	}
}

// The framing is not negotiable: the caller resamples and frames to it, so a
// package declaring something else is not one this build can drive.
func TestResolveInstallRefusesADifferentFraming(t *testing.T) {
	for _, field := range []string{"sampleRate", "frameSamples"} {
		manifest := completeManifest()
		manifest[field] = 12345
		writeInstall(t, manifest, completeFiles())
		if _, err := resolveInstall(); err == nil {
			t.Errorf("a package declaring a different %s was accepted", field)
		}
	}
}

func TestResolveInstallReportsNoInstallation(t *testing.T) {
	writeInstall(t, nil, nil)
	if _, err := resolveInstall(); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("err = %v, want ErrNotInstalled", err)
	}
}

// A state whose declared shape disagrees with how many values it carries would
// be fed to the model as a differently shaped tensor, failing deep in the graph
// rather than here.
func TestInitialStatesContractIsChecked(t *testing.T) {
	valid := map[string]state{}
	for index := range stateCount {
		valid["state"+string(rune('a'+index))] = state{Shape: []int64{2}, Values: []float32{0, 0}}
	}

	write := func(t *testing.T, states map[string]state) string {
		t.Helper()
		body, err := json.Marshal(states)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		path := filepath.Join(t.TempDir(), "states.json")
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		return path
	}

	if _, err := loadInitialStates(write(t, valid)); err != nil {
		t.Errorf("a valid state set was rejected: %v", err)
	}

	tooFew := map[string]state{"only": {Shape: []int64{1}, Values: []float32{0}}}
	if _, err := loadInitialStates(write(t, tooFew)); err == nil {
		t.Error("a state set of the wrong size was accepted")
	}

	mismatched := map[string]state{}
	for name, value := range valid {
		mismatched[name] = value
	}
	mismatched["statea"] = state{Shape: []int64{4}, Values: []float32{0, 0}}
	if _, err := loadInitialStates(write(t, mismatched)); err == nil {
		t.Error("a state whose shape disagrees with its values was accepted")
	}

	// JSON cannot carry a non-finite number, so this rule is exercised against
	// the validation directly rather than through a file.
	nonFinite := map[string]state{}
	for name, value := range valid {
		nonFinite[name] = value
	}
	nonFinite["stateb"] = state{Shape: []int64{2}, Values: []float32{float32(math.NaN()), 0}}
	if err := validateStates(nonFinite); err == nil {
		t.Error("a state holding a non-finite value was accepted")
	}
}

// Cloning must be deep, or resetting would be undone by the next frame writing
// through a shared slice.
func TestCloningStatesIsDeep(t *testing.T) {
	original := map[string]state{"a": {Shape: []int64{2}, Values: []float32{1, 2}}}
	copied := cloneStates(original)

	copied["a"].Values[0] = 99
	if original["a"].Values[0] != 1 {
		t.Error("writing to the copy changed the original")
	}
	copied["a"].Shape[0] = 99
	if original["a"].Shape[0] != 2 {
		t.Error("the shape is shared between copies")
	}
}

func TestProcessBeforeLoadFails(t *testing.T) {
	engine := NewEngine()
	t.Cleanup(engine.Close)

	if _, err := engine.Process(make([]float32, FrameSamples)); err == nil {
		t.Error("processing succeeded before the model was loaded")
	} else if !strings.Contains(err.Error(), "not loaded") {
		t.Errorf("err = %v, want the not-loaded reason", err)
	}
	if err := engine.Reset(); err == nil {
		t.Error("resetting succeeded before the model was loaded")
	}
}

func TestCloseIsSafeWhenNothingIsLoaded(t *testing.T) {
	engine := NewEngine()
	engine.Close()
	engine.Close()
}
