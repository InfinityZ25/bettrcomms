// Package dspsetup embeds the same pinned installers, models and licences used
// by Tauri. Only the explicit, authorised install action runs these scripts.
package dspsetup

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"bettercomms/desktop-wails/internal/native/gpudevices"
	"bettercomms/desktop-wails/internal/native/nvidiaaudio"
)

//go:embed assets/* assets/deepfilter/*
var assets embed.FS

type Info struct {
	SchemaVersion   int    `json:"schemaVersion"`
	Supported       bool   `json:"supported"`
	Installed       bool   `json:"installed"`
	GPUName         string `json:"gpuName,omitempty"`
	SelectedPackage string `json:"selectedPackage,omitempty"`
	DownloadBytes   int64  `json:"downloadBytes"`
	Detail          string `json:"detail"`
}

type Result struct {
	Installed   bool   `json:"installed"`
	Destination string `json:"destination"`
}
type recipe struct {
	directory, prefix, script string
	download                  int64
	timeout                   time.Duration
	required                  []string
}

var recipes = map[string]recipe{
	"nvidia": {"nvidia-audio-effects", "nvidia-install-", "install-nvidia-audio.ps1", 706540584, 35 * time.Minute,
		[]string{"setup.json", "runtime/NVAudioEffects.dll", "models/denoiser_48k.trtpkg"}},
	"deepfilter": {"deepfilter-directml", "deepfilter-install-", "install-deepfilter.ps1", 215038684, 15 * time.Minute,
		[]string{"setup.json", "runtime/onnxruntime.dll", "runtime/onnxruntime_providers_shared.dll", "runtime/DirectML.dll",
			"models/denoiser_model.onnx", "models/initial_states.json", "models/meta.json",
			"notices/onnxruntime-LICENSE", "notices/onnxruntime-ThirdPartyNotices.txt", "notices/directml-LICENSE.txt",
			"notices/directml-LICENSE-CODE.txt", "notices/directml-ThirdPartyNotices.txt", "notices/deepfilter-stream-LICENSE",
			"notices/deepfilter-stream-NOTICE", "notices/DeepFilterNet-LICENSE", "notices/DeepFilterNet-LICENSE-APACHE",
			"notices/DeepFilterNet-LICENSE-MIT", "notices/Bettercomms-MODEL-NOTICE.txt"}},
}
var installMu sync.Mutex

func appRoot() (string, error) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" || !filepath.IsAbs(local) {
		return "", errors.New("absolute LOCALAPPDATA is required")
	}
	return filepath.Join(local, "Bettercomms"), nil
}

func ready(root string, required []string) bool {
	for _, name := range required {
		if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(name))); err != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	return true
}

func Describe(engine string) Info {
	r, exists := recipes[engine]
	if !exists {
		return Info{SchemaVersion: 1, Detail: "Unknown microphone processor"}
	}
	info := Info{SchemaVersion: 1, DownloadBytes: r.download}
	if root, err := appRoot(); err == nil {
		info.Installed = ready(filepath.Join(root, r.directory), r.required)
	}
	if runtime.GOOS == "windows" && runtime.GOARCH == "amd64" {
		if engine == "nvidia" {
			nvidia := nvidiaaudio.Describe()
			info.Supported, info.GPUName = nvidia.Supported, nvidia.GPUName
			if info.Supported {
				info.SelectedPackage = nvidia.Package
			}
		} else {
			adapters, err := gpudevices.CompatibleAdapters()
			info.Supported = err == nil && len(adapters) > 0
		}
	}
	switch {
	case info.Installed:
		info.Detail = "Runtime files are installed; readiness requires a native GPU probe."
	case info.Supported:
		info.Detail = "The pinned optional runtime can be installed for this GPU."
	default:
		info.Detail = "The pinned runtime requires a compatible GPU on Windows x64."
	}
	return info
}

func Install(ctx context.Context, engine string) (Result, error) {
	r, exists := recipes[engine]
	if !exists {
		return Result{}, errors.New("unknown microphone processor")
	}
	if !installMu.TryLock() {
		return Result{}, errors.New("native audio setup is already running")
	}
	defer installMu.Unlock()
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	info := Describe(engine)
	if !info.Supported {
		return Result{}, errors.New(info.Detail)
	}
	if info.Installed {
		return Result{}, errors.New("runtime is already installed; restart Bettercomms to load it")
	}
	root, err := appRoot()
	if err != nil {
		return Result{}, err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return Result{}, err
	}
	if err = requirePlainDirectory(root); err != nil {
		return Result{}, err
	}
	destination := filepath.Join(root, r.directory)
	if _, err := os.Lstat(destination); err == nil {
		if err := requirePlainDirectory(destination); err != nil {
			return Result{}, err
		}
	} else if !os.IsNotExist(err) {
		return Result{}, err
	}
	work, err := os.MkdirTemp(root, r.prefix)
	if err != nil {
		return Result{}, err
	}
	// work is a new random child of the verified private app directory, never
	// a path supplied by a document. No existing installation is cleaned here.
	defer os.RemoveAll(work)
	script, err := assets.ReadFile("assets/" + r.script)
	if err != nil {
		return Result{}, err
	}
	scriptPath := filepath.Join(work, r.script)
	if err := os.WriteFile(scriptPath, script, 0600); err != nil {
		return Result{}, err
	}
	args := []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
		"-Destination", destination, "-WorkingDirectory", work}
	if engine == "deepfilter" {
		bundled := filepath.Join(work, "bundled")
		if err := os.Mkdir(bundled, 0700); err != nil {
			return Result{}, err
		}
		entries, err := assets.ReadDir("assets/deepfilter")
		if err != nil {
			return Result{}, err
		}
		for _, entry := range entries {
			body, err := assets.ReadFile("assets/deepfilter/" + entry.Name())
			if err != nil {
				return Result{}, err
			}
			if err := os.WriteFile(filepath.Join(bundled, entry.Name()), body, 0600); err != nil {
				return Result{}, err
			}
		}
		args = append(args, "-BundledAssets", bundled)
	}
	bounded, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	if err := runInstaller(bounded, args); err != nil {
		return Result{}, fmt.Errorf("%s setup: %w", engine, err)
	}
	if !ready(destination, r.required) {
		return Result{}, errors.New("setup completed without all required runtime files and notices")
	}
	return Result{Installed: true, Destination: destination}, nil
}
