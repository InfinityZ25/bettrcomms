// Package nvidiaaudio runs NVIDIA Audio Effects noise removal on the
// microphone.
//
// The SDK is not redistributable, so nothing here ships with the application.
// A person installs it themselves, and this package loads it from an
// app-private directory described by a manifest. Every path in that manifest is
// re-checked against the directory it came from: the manifest is a file on
// disk, and a file on disk is not a reason to load an arbitrary DLL.
package nvidiaaudio

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// SampleRate is what the model expects. Anything else is resampled by the
	// caller before it gets here.
	SampleRate = 48_000
	// MaxFrameSamples is 20 ms at 48 kHz. The SDK supports 10 ms or 20 ms
	// frames; the model reports which, and it must be within this.
	MaxFrameSamples = 960

	// statusProbeCacheTTL keeps a failed probe from reloading the SDK on every
	// settings render. Loading it costs a GPU context.
	statusProbeCacheTTL = 60 * time.Second

	// sdkFileName is the only DLL this package will load. The manifest names a
	// path; this names what has to be at the end of it.
	sdkFileName = "NVAudioEffects.dll"
)

// Status is what the settings screen renders.
type Status struct {
	Available bool   `json:"available"`
	Installed bool   `json:"installed"`
	Detail    string `json:"detail"`
	// FrameSamples is how many samples one call processes. Zero until a model
	// has actually loaded.
	FrameSamples uint32 `json:"frameSamples"`
}

// setupManifest describes an installation.
type setupManifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	SDKDLL        string `json:"sdkDll"`
	Model         string `json:"model"`
}

var (
	// ErrNotInstalled reports that no manifest was found.
	ErrNotInstalled = errors.New("NVIDIA Audio Effects is not installed for Bettercomms")
	// ErrUnsupportedPlatform reports a platform with no SDK.
	ErrUnsupportedPlatform = errors.New("NVIDIA Audio Effects is available only on Windows")
)

// manifestCandidates are the places an installation may live, most specific
// first. Both are app-private: nothing on PATH or in a shared location is
// consulted, because the result decides which DLL this process loads.
func manifestCandidates() []string {
	var candidates []string
	if repository := os.Getenv("BETTERCOMMS_REPO"); repository != "" {
		candidates = append(candidates, filepath.Join(repository, ".local", "nvidia-audio-effects", "setup.json"))
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		candidates = append(candidates, filepath.Join(local, "Bettercomms", "nvidia-audio-effects", "setup.json"))
	}
	return candidates
}

// resolveSetup finds an installation and returns its verified DLL and model.
func resolveSetup() (string, string, error) {
	var manifestPath string
	for _, candidate := range manifestCandidates() {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			manifestPath = candidate
			break
		}
	}
	if manifestPath == "" {
		return "", "", ErrNotInstalled
	}

	root, err := filepath.EvalSymlinks(filepath.Dir(manifestPath))
	if err != nil {
		return "", "", errors.New("NVIDIA setup directory is unavailable")
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", "", errors.New("NVIDIA setup directory is unavailable")
	}

	body, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", "", errors.New("NVIDIA setup manifest could not be read")
	}
	var manifest setupManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return "", "", errors.New("NVIDIA setup manifest is invalid")
	}
	if manifest.SchemaVersion != 1 {
		return "", "", errors.New("NVIDIA setup manifest version is unsupported")
	}

	dll, err := trustedFile(root, manifest.SDKDLL, "SDK DLL")
	if err != nil {
		return "", "", err
	}
	model, err := trustedFile(root, manifest.Model, "model")
	if err != nil {
		return "", "", err
	}
	if filepath.Base(dll) != sdkFileName {
		return "", "", fmt.Errorf("NVIDIA setup SDK DLL must be named %s", sdkFileName)
	}
	return dll, model, nil
}

// trustedFile resolves a manifest-relative path and refuses anything that
// escapes the setup directory.
//
// The manifest is a file on disk; a file on disk is not a reason to load an
// arbitrary DLL. Both checks matter: the syntactic one rejects traversal before
// touching the filesystem, and the resolved one catches a symlink pointing out.
func trustedFile(root, relative, label string) (string, error) {
	if relative == "" {
		return "", fmt.Errorf("NVIDIA %s path is missing", label)
	}
	if filepath.IsAbs(relative) || strings.HasPrefix(relative, `\\`) {
		return "", fmt.Errorf("NVIDIA %s path must be a simple relative path", label)
	}
	// A drive-relative path such as "C:model.bin" is absolute in effect.
	if volume := filepath.VolumeName(relative); volume != "" {
		return "", fmt.Errorf("NVIDIA %s path must be a simple relative path", label)
	}
	for _, part := range strings.Split(filepath.ToSlash(relative), "/") {
		if part == "." || part == ".." {
			return "", fmt.Errorf("NVIDIA %s path must be a simple relative path", label)
		}
	}

	resolved, err := filepath.EvalSymlinks(filepath.Join(root, relative))
	if err != nil {
		return "", fmt.Errorf("NVIDIA %s is missing", label)
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", fmt.Errorf("NVIDIA %s is missing", label)
	}
	if !within(root, resolved) {
		return "", fmt.Errorf("NVIDIA %s is outside the app-private setup directory", label)
	}
	if info, err := os.Stat(resolved); err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("NVIDIA %s is missing", label)
	}
	return resolved, nil
}

// within reports whether path is root or sits under it, comparing whole path
// components so a sibling with a shared prefix is not accepted.
func within(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	if relative == "." {
		return true
	}
	return !strings.HasPrefix(relative, "..")
}

// validateIntensity bounds the denoise strength the page may ask for.
func validateIntensity(intensity float32) (float32, error) {
	if intensity < 0 || intensity > 1 {
		return 0, errors.New("NVIDIA denoise intensity must be between 0 and 1")
	}
	return intensity, nil
}

// Engine owns the loaded SDK and the effect it created.
//
// The SDK handle is used from one goroutine only, which the mutex enforces:
// the effect is not documented as thread-safe, and audio arrives from whatever
// goroutine the caller is on.
type Engine struct {
	mu     sync.Mutex
	sdk    *sdkRuntime
	effect *effect

	probeMu     sync.Mutex
	probedAt    time.Time
	probeResult Status
}

// NewEngine returns an engine with nothing loaded yet.
func NewEngine() *Engine { return &Engine{} }

// InvalidateStatus makes an explicit successful install visible immediately,
// without replacing the engine or racing an in-progress capability probe.
func (e *Engine) InvalidateStatus() {
	e.probeMu.Lock()
	defer e.probeMu.Unlock()
	e.probedAt = time.Time{}
}

// Status reports whether the SDK is installed and usable, caching a result for
// a minute so rendering a settings screen does not reload a GPU model.
func (e *Engine) Status() Status {
	e.probeMu.Lock()
	defer e.probeMu.Unlock()
	if !e.probedAt.IsZero() && time.Since(e.probedAt) < statusProbeCacheTTL {
		return e.probeResult
	}

	status := e.probe()
	e.probedAt = time.Now()
	e.probeResult = status
	return status
}

func (e *Engine) probe() Status {
	if !supported {
		return Status{Detail: ErrUnsupportedPlatform.Error()}
	}
	if _, _, err := resolveSetup(); err != nil {
		return Status{Detail: err.Error()}
	}

	// Installed is not the same as usable: the SDK needs an NVIDIA GPU and a
	// driver that will load its model. Create a real effect to find out.
	frameSamples, err := e.probeEffect()
	if err != nil {
		return Status{Installed: true, Detail: err.Error()}
	}
	return Status{
		Available:    true,
		Installed:    true,
		FrameSamples: frameSamples,
		Detail:       fmt.Sprintf("NVIDIA Audio Effects is ready, processing %d samples per frame", frameSamples),
	}
}

// Start loads the model and prepares the engine to process audio.
func (e *Engine) Start(intensity float32, vad bool) (uint32, error) {
	bounded, err := validateIntensity(intensity)
	if err != nil {
		return 0, err
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	e.closeEffectLocked()

	if err := e.ensureRuntimeLocked(); err != nil {
		return 0, err
	}
	created, err := e.sdk.createEffect(bounded, vad)
	if err != nil {
		return 0, err
	}
	e.effect = created
	return created.frameSamples, nil
}

// Process denoises exactly one frame.
func (e *Engine) Process(samples []float32) ([]float32, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.effect == nil {
		return nil, errors.New("NVIDIA Audio Effects is not running")
	}
	return e.effect.process(samples)
}

// Stop releases the effect but keeps the SDK loaded, so restarting is cheap.
func (e *Engine) Stop() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closeEffectLocked()
}

// Close releases everything, including the SDK.
func (e *Engine) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closeEffectLocked()
	if e.sdk != nil {
		e.sdk.close()
		e.sdk = nil
	}
}

func (e *Engine) closeEffectLocked() {
	if e.effect != nil {
		e.effect.close()
		e.effect = nil
	}
}

func (e *Engine) ensureRuntimeLocked() error {
	if e.sdk != nil {
		return nil
	}
	loaded, err := loadRuntime()
	if err != nil {
		return err
	}
	e.sdk = loaded
	return nil
}

// probeEffect creates and immediately discards an effect, which is the only
// way to know the GPU will actually run the model.
func (e *Engine) probeEffect() (uint32, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.ensureRuntimeLocked(); err != nil {
		return 0, err
	}
	created, err := e.sdk.createEffect(0.5, false)
	if err != nil {
		return 0, err
	}
	frameSamples := created.frameSamples
	created.close()
	return frameSamples, nil
}
