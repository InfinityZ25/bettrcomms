package nvidiaaudio

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"bettercomms/desktop-wails/internal/native/gpudevices"
)

// Whether this machine can run NVIDIA Audio Effects at all.
//
// The engine itself answers that by loading the SDK and creating an effect,
// which needs the package to be installed first. This answers the question
// before that: is there hardware here the pinned package supports, and is the
// package present. It is what a settings screen needs to decide between
// offering an install, offering nothing, and saying why.
//
// Adapters come from DXGI rather than from WMI through PowerShell, which is how
// the Tauri host asks. DXGI is already how this host enumerates graphics
// devices for DirectML, it needs no subprocess, and it reports the same
// adapter names.

// InstallInfo is what a settings screen renders before anything is installed.
type InstallInfo struct {
	SchemaVersion int `json:"schemaVersion"`
	// Supported reports NVIDIA hardware the pinned package targets.
	Supported bool `json:"supported"`
	// Installed reports a complete package on disk.
	Installed bool `json:"installed"`
	// GPUName is the adapter this decision was made about, when there is one.
	GPUName string `json:"gpuName,omitempty"`
	// Package names the pinned build, so a report says which one.
	Package string `json:"package,omitempty"`
	Detail  string `json:"detail"`
}

// pinnedPackage is the only build this host drives. Naming it in the report
// keeps a bug report from having to guess which one was installed.
const pinnedPackage = "NVIDIA Audio Effects SDK 1.6.1.2 Ada"

// SupportsPinnedPackage reports whether an adapter name is one the pinned
// package runs on.
//
// The pinned build is the Ada one, and NVIDIA ships different packages per
// architecture: an Ada package on an Ampere card loads and then fails inside
// the model, which is a much worse experience than being told up front. The
// match is on the marketing name because that is what DXGI reports and what a
// person can check against their own machine.
func SupportsPinnedPackage(name string) bool {
	upper := strings.ToUpper(name)
	if !strings.Contains(upper, "NVIDIA") && !strings.Contains(upper, "RTX") && !strings.Contains(upper, "GEFORCE") {
		return false
	}
	if strings.Contains(upper, "GEFORCE RTX 40") {
		return true
	}
	// The workstation Ada cards spell the architecture out: "RTX 4000 Ada
	// Generation", "RTX 5880 Ada Generation".
	return strings.Contains(upper, "RTX ") && strings.Contains(upper, " ADA")
}

// supportedAdapter returns the first adapter the pinned package runs on, and
// the first NVIDIA adapter otherwise, so an unsupported machine can still be
// told which card it has.
func supportedAdapter() (name string, supported bool) {
	adapters, err := gpudevices.AllAdapters()
	if err != nil {
		return "", false
	}
	var fallback string
	for _, adapter := range adapters {
		if SupportsPinnedPackage(adapter.Name) {
			return adapter.Name, true
		}
		if adapter.VendorID == gpudevices.VendorNVIDIA && fallback == "" {
			fallback = adapter.Name
		}
	}
	return fallback, false
}

// Describe reports whether this machine can run the denoiser and whether the
// package is already here.
func Describe() InstallInfo {
	info := InstallInfo{SchemaVersion: 1}
	if runtime.GOOS != "windows" {
		info.Detail = ErrUnsupportedPlatform.Error()
		return info
	}

	_, _, err := resolveSetup()
	info.Installed = err == nil

	name, supported := supportedAdapter()
	info.GPUName, info.Supported = name, supported
	if supported {
		info.Package = pinnedPackage
	}

	switch {
	case info.Installed:
		info.Detail = "The NVIDIA Audio Effects runtime is installed. Restart BetterComms if it is still reported unavailable."
	case supported:
		info.Detail = "A supported NVIDIA Ada GPU was found. Install " + pinnedPackage + " to enable the denoiser."
	case name != "":
		info.Detail = "This host pins the Ada build of NVIDIA Audio Effects, which does not run on " + name + "."
	default:
		info.Detail = "No NVIDIA GPU was found, so NVIDIA Audio Effects cannot run here. DeepFilterNet through DirectML is the denoiser on this machine."
	}
	return info
}

// InstallRoot is where a package must be unpacked for this host to find it.
//
// Returned rather than installed into, because the package is a multi-hundred-
// megabyte NVIDIA redistributable behind their own terms. Whoever installs it —
// an operator, a setup script, a later installer in this host — puts it here,
// and this is the one place that decides where "here" is.
func InstallRoot() (string, error) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return "", ErrNotInstalled
	}
	return filepath.Join(local, "Bettercomms", "nvidia-audio-effects"), nil
}
