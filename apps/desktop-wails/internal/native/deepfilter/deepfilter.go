// Package deepfilter runs DeepFilterNet3 noise suppression on the GPU through
// DirectML.
//
// DirectML runs on AMD and Intel graphics, which is what makes a GPU denoiser
// available to people without an NVIDIA card. Registration is explicit and the
// whole graph must land on the selected adapter: a silent fall back to CPU
// would turn a real-time filter into something that cannot keep up, and would
// do it invisibly.
//
// Nothing here ships with the application. A person installs the runtime and
// model themselves, and every path in the install manifest is re-checked
// against the directory it came from before anything is loaded.
package deepfilter

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	// SampleRate and FrameSamples are the model's contract. The caller resamples
	// and frames to these before calling.
	SampleRate   = 48_000
	FrameSamples = 512

	// modelDelay is three hops: the analysis and synthesis overlap plus the
	// model's own lookahead. The dry signal is delayed by this much so the mix
	// lines up with what the model returns.
	modelDelay = 1536

	// stateCount is how many recurrent tensors the model carries between
	// frames. A model with a different number is a different model.
	stateCount = 12

	// inputName is the one non-state input.
	inputName = "input_frame"
)

// Status is what the settings screen renders.
type Status struct {
	Available bool   `json:"available"`
	Installed bool   `json:"installed"`
	Detail    string `json:"detail"`
	// Adapter names the GPU the graph was placed on, so someone can tell which
	// device is doing the work.
	Adapter string `json:"adapter,omitempty"`
}

// setupManifest describes an installation.
type setupManifest struct {
	SchemaVersion     int    `json:"schemaVersion"`
	RuntimeDLL        string `json:"runtimeDll"`
	ProviderSharedDLL string `json:"providerSharedDll"`
	DirectMLDLL       string `json:"directmlDll"`
	Model             string `json:"model"`
	InitialStates     string `json:"initialStates"`
	SampleRate        int    `json:"sampleRate"`
	FrameSamples      int    `json:"frameSamples"`
}

// install is a verified installation.
type install struct {
	root          string
	runtimeDLL    string
	directMLDLL   string
	model         string
	initialStates string
}

// state is one recurrent tensor.
type state struct {
	Shape  []int64   `json:"shape"`
	Values []float32 `json:"values"`
}

var (
	// ErrNotInstalled reports that no manifest was found.
	ErrNotInstalled = errors.New("The optional DeepFilterNet DirectML package is not installed")
	// ErrUnsupportedPlatform reports a platform with no DirectML.
	ErrUnsupportedPlatform = errors.New("DeepFilterNet DirectML requires Windows")
)

// InstallRoot is where the runtime and model live.
func InstallRoot() (string, error) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return "", ErrNotInstalled
	}
	return filepath.Join(local, "Bettercomms", "deepfilter-directml"), nil
}

// resolveInstall reads the manifest and verifies every path it names.
func resolveInstall() (install, error) {
	root, err := InstallRoot()
	if err != nil {
		return install{}, err
	}
	manifestPath := filepath.Join(root, "setup.json")
	body, err := os.ReadFile(manifestPath)
	if err != nil {
		return install{}, ErrNotInstalled
	}

	var manifest setupManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return install{}, errors.New("DeepFilterNet setup manifest is invalid")
	}
	if manifest.SchemaVersion != 1 {
		return install{}, errors.New("DeepFilterNet setup manifest version is unsupported")
	}
	// The model's framing is not negotiable: the caller frames to it.
	if manifest.SampleRate != SampleRate || manifest.FrameSamples != FrameSamples {
		return install{}, fmt.Errorf("DeepFilterNet package declares %d Hz / %d samples, but this build needs %d / %d",
			manifest.SampleRate, manifest.FrameSamples, SampleRate, FrameSamples)
	}

	resolvedRoot, err := filepath.Abs(root)
	if err != nil {
		return install{}, errors.New("DeepFilterNet setup directory is unavailable")
	}
	resolved := install{root: resolvedRoot}
	for _, entry := range []struct {
		relative string
		label    string
		target   *string
	}{
		{manifest.RuntimeDLL, "runtime", &resolved.runtimeDLL},
		{manifest.DirectMLDLL, "DirectML runtime", &resolved.directMLDLL},
		{manifest.Model, "model", &resolved.model},
		{manifest.InitialStates, "initial states", &resolved.initialStates},
	} {
		path, err := trustedFile(resolvedRoot, entry.relative, entry.label)
		if err != nil {
			return install{}, err
		}
		*entry.target = path
	}
	// The shared provider DLL is loaded by name from the same directory, so it
	// is verified even though its path is never used directly.
	if manifest.ProviderSharedDLL != "" {
		if _, err := trustedFile(resolvedRoot, manifest.ProviderSharedDLL, "provider runtime"); err != nil {
			return install{}, err
		}
	}
	return resolved, nil
}

// trustedFile resolves a manifest-relative path and refuses anything escaping
// the install directory.
//
// The manifest is a file on disk; a file on disk is not a reason to load an
// arbitrary DLL into this process.
func trustedFile(root, relative, label string) (string, error) {
	if relative == "" {
		return "", fmt.Errorf("DeepFilterNet %s path is missing", label)
	}
	if filepath.IsAbs(relative) || strings.HasPrefix(relative, `\\`) || filepath.VolumeName(relative) != "" {
		return "", fmt.Errorf("DeepFilterNet %s path must be a simple relative path", label)
	}
	for _, part := range strings.Split(filepath.ToSlash(relative), "/") {
		if part == "." || part == ".." {
			return "", fmt.Errorf("DeepFilterNet %s path must be a simple relative path", label)
		}
	}

	resolved, err := filepath.EvalSymlinks(filepath.Join(root, relative))
	if err != nil {
		return "", fmt.Errorf("DeepFilterNet %s is missing", label)
	}
	if resolved, err = filepath.Abs(resolved); err != nil {
		return "", fmt.Errorf("DeepFilterNet %s is missing", label)
	}
	if relativeTo, err := filepath.Rel(root, resolved); err != nil || strings.HasPrefix(relativeTo, "..") {
		return "", fmt.Errorf("DeepFilterNet %s is outside the app-private install directory", label)
	}
	if info, err := os.Stat(resolved); err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("DeepFilterNet %s is missing", label)
	}
	return resolved, nil
}

// loadInitialStates reads the model's starting recurrent state.
//
// The contract is checked rather than trusted: a state whose declared shape
// does not match how many values it carries would be fed to the model as a
// differently shaped tensor, which fails deep inside the graph rather than
// here.
func loadInitialStates(path string) (map[string]state, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("DeepFilterNet initial states could not be read")
	}
	var states map[string]state
	if err := json.Unmarshal(body, &states); err != nil {
		return nil, errors.New("Bundled DeepFilterNet state contract is invalid.")
	}
	if err := validateStates(states); err != nil {
		return nil, err
	}
	return states, nil
}

// validateStates checks the contract separately from reading it, so the rules
// can be exercised with values JSON cannot carry.
func validateStates(states map[string]state) error {
	if len(states) != stateCount {
		return fmt.Errorf("DeepFilterNet expects %d states, the package carries %d", stateCount, len(states))
	}
	for name, value := range states {
		if len(value.Shape) == 0 {
			return fmt.Errorf("DeepFilterNet state %q has no shape", name)
		}
		expected := int64(1)
		for _, dimension := range value.Shape {
			if dimension <= 0 {
				return fmt.Errorf("DeepFilterNet state %q has a non-positive dimension", name)
			}
			expected *= dimension
		}
		if expected != int64(len(value.Values)) {
			return fmt.Errorf("DeepFilterNet state %q declares %d values but carries %d",
				name, expected, len(value.Values))
		}
		// JSON cannot carry a non-finite number, so this cannot trigger through
		// the file above. It stays because the rule belongs with the others: a
		// non-finite state poisons every frame the model produces afterwards.
		for _, sample := range value.Values {
			if math.IsNaN(float64(sample)) || math.IsInf(float64(sample), 0) {
				return fmt.Errorf("DeepFilterNet state %q holds a non-finite value", name)
			}
		}
	}
	return nil
}

// cloneStates returns an independent copy, so resetting cannot be undone by a
// later frame writing through a shared slice.
func cloneStates(source map[string]state) map[string]state {
	copied := make(map[string]state, len(source))
	for name, value := range source {
		copied[name] = state{
			Shape:  append([]int64(nil), value.Shape...),
			Values: append([]float32(nil), value.Values...),
		}
	}
	return copied
}

// dryMixFor converts a maximum attenuation in decibels into how much of the
// original signal to keep.
//
// Full attenuation means none of it; anything less leaves a floor of the
// original so heavy suppression does not sound like the speaker is cutting out.
func dryMixFor(attenuationDB float32) (float32, error) {
	if math.IsNaN(float64(attenuationDB)) || math.IsInf(float64(attenuationDB), 0) ||
		attenuationDB < 0 || attenuationDB > 100 {
		return 0, errors.New("Invalid DeepFilterNet maximum attenuation.")
	}
	if attenuationDB >= 100 {
		return 0, nil
	}
	return float32(math.Pow(10, float64(-attenuationDB)/20)), nil
}

// validateFrame bounds what is fed to the model.
func validateFrame(frame []float32, what string) error {
	if len(frame) != FrameSamples {
		return fmt.Errorf("%s must be exactly %d samples", what, FrameSamples)
	}
	for _, sample := range frame {
		// Beyond this is not audio; feeding it to the model produces noise the
		// mix below would then amplify.
		if math.IsNaN(float64(sample)) || math.IsInf(float64(sample), 0) || sample > 8 || sample < -8 {
			return fmt.Errorf("%s holds a sample outside the usable range", what)
		}
	}
	return nil
}

// delayLine holds the dry signal so the mix lines up with the model's output.
type delayLine struct {
	buffer []float32
	next   int
}

func newDelayLine() *delayLine { return &delayLine{buffer: make([]float32, modelDelay)} }

// push stores a sample and returns the one from modelDelay samples ago.
func (d *delayLine) push(sample float32) float32 {
	delayed := d.buffer[d.next]
	d.buffer[d.next] = sample
	d.next = (d.next + 1) % len(d.buffer)
	return delayed
}

func (d *delayLine) reset() {
	for index := range d.buffer {
		d.buffer[index] = 0
	}
	d.next = 0
}

// Engine owns the loaded session.
//
// The session is used from one goroutine at a time, which the mutex enforces:
// ORT sessions are not required to be re-entrant, and audio arrives from
// whatever goroutine the caller is on.
type Engine struct {
	mu      sync.Mutex
	session *session
	states  map[string]state
	initial map[string]state
	dry     *delayLine
	dryMix  float32
	adapter string
}

// NewEngine returns an engine with nothing loaded.
func NewEngine() *Engine { return &Engine{} }

// Status reports whether the package is installed and whether the graph will
// actually run on a GPU here.
func (e *Engine) Status() Status {
	if !supported {
		return Status{Detail: ErrUnsupportedPlatform.Error()}
	}
	if _, err := resolveInstall(); err != nil {
		if errors.Is(err, ErrNotInstalled) {
			return Status{Detail: "The pinned DeepFilterNet and DirectML runtime can be installed for this Windows x64 device"}
		}
		return Status{Detail: err.Error()}
	}

	// Installed is not usable. Loading the graph is the only way to know
	// DirectML will place it on this machine's adapter.
	probe := NewEngine()
	defer probe.Close()
	if err := probe.Load(30); err != nil {
		return Status{Installed: true, Detail: err.Error()}
	}
	return Status{
		Available: true,
		Installed: true,
		Adapter:   probe.adapter,
		Detail:    fmt.Sprintf("DeepFilterNet is running on %s through DirectML", probe.adapter),
	}
}

// Load prepares the model with the given maximum attenuation in decibels.
func (e *Engine) Load(attenuationDB float32) error {
	mix, err := dryMixFor(attenuationDB)
	if err != nil {
		return err
	}
	resolved, err := resolveInstall()
	if err != nil {
		return err
	}
	initial, err := loadInitialStates(resolved.initialStates)
	if err != nil {
		return err
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	e.closeLocked()

	opened, adapter, err := openSession(resolved)
	if err != nil {
		return err
	}
	if err := opened.verifyContract(initial); err != nil {
		opened.close()
		return err
	}

	e.session = opened
	e.initial = initial
	e.states = cloneStates(initial)
	e.dry = newDelayLine()
	e.dryMix = mix
	e.adapter = adapter
	return nil
}

// Adapter names the GPU the graph was placed on.
func (e *Engine) Adapter() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.adapter
}

// Reset returns the model to its starting state, which is what a new call
// needs so the previous one's tail does not bleed into it.
func (e *Engine) Reset() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.session == nil {
		return errors.New("DeepFilterNet is not loaded")
	}
	e.states = cloneStates(e.initial)
	e.dry.reset()
	return nil
}

// Process denoises exactly one frame.
func (e *Engine) Process(frame []float32) ([]float32, error) {
	if err := validateFrame(frame, "DeepFilterNet input"); err != nil {
		return nil, err
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.session == nil {
		return nil, errors.New("DeepFilterNet is not loaded")
	}

	denoised, err := e.session.run(frame, e.states)
	if err != nil {
		return nil, err
	}
	if err := validateFrame(denoised, "DeepFilterNet output"); err != nil {
		return nil, err
	}

	// Mix the delayed original back in. Doing it here rather than in the graph
	// keeps the attenuation adjustable without reloading the model.
	result := make([]float32, len(denoised))
	for index := range denoised {
		delayed := e.dry.push(frame[index])
		result[index] = delayed*e.dryMix + denoised[index]*(1-e.dryMix)
	}
	return result, nil
}

// Close releases the session.
func (e *Engine) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closeLocked()
}

func (e *Engine) closeLocked() {
	if e.session != nil {
		e.session.close()
		e.session = nil
	}
	e.states = nil
	e.initial = nil
	e.dry = nil
	e.adapter = ""
}
