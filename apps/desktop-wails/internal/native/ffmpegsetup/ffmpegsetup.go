// Package ffmpegsetup installs and locates the private FFmpeg runtime that
// native sharing depends on.
//
// The Tauri host delegated this to a PowerShell script. Here it is Go: the
// download, the pinned-length and SHA-256 checks, the archive extraction, the
// capability probe, and the atomic swap all happen in this process. That
// removes a scripting host from the trusted path and makes every check
// testable.
//
// Nothing about the runtime is taken on trust. The archive must match a pinned
// length and digest, each extracted file must match its own, and the resulting
// binary must actually report the Windows Graphics Capture filter before it is
// allowed to replace an existing install.
package ffmpegsetup

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The pinned FFmpeg 8.1 full build. Changing any of these values changes what
// the application is willing to execute, so they move together or not at all.
const (
	downloadURL   = "https://github.com/GyanD/codexffmpeg/releases/download/8.1/ffmpeg-8.1-full_build.zip"
	archiveBytes  = 247_913_948
	archiveSHA256 = "587b1c37de29c5003d01cf65da10001bac43a58b88e61af0fc77c61daff04761"
	ffmpegBytes   = 223_360_000
	ffmpegSHA256  = "d1e2a156261ecc675081943197a85f08f2868784a0af499171ede89353edad31"
	licenseBytes  = 35_147
	licenseSHA256 = "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"

	// Entry names inside the pinned archive, with the caps applied before any
	// bytes are written, so a tampered archive cannot fill the disk.
	ffmpegEntry     = "ffmpeg-8.1-full_build/bin/ffmpeg.exe"
	licenseEntry    = "ffmpeg-8.1-full_build/LICENSE"
	ffmpegEntryCap  = 224_000_000
	licenseEntryCap = 100_000

	// InstallDirName is the only directory name this package will install into.
	InstallDirName = "ffmpeg-8.1"
	appDirName     = "Bettercomms"

	installTimeout  = 15 * time.Minute
	downloadTimeout = 12 * time.Minute
)

// InstallInfo describes whether the runtime is present and what installing it
// would cost.
type InstallInfo struct {
	Supported      bool   `json:"supported"`
	Installed      bool   `json:"installed"`
	DownloadBytes  int64  `json:"downloadBytes"`
	InstalledBytes int64  `json:"installedBytes"`
	Detail         string `json:"detail"`
}

// InstallResult is the outcome of an install attempt.
type InstallResult struct {
	Installed       bool `json:"installed"`
	RestartRequired bool `json:"restartRequired"`
}

var (
	// installing is a single-flight gate. A second concurrent install is
	// refused rather than queued: two of them would race on the same
	// destination directory.
	installing atomic.Bool

	bundledOnce sync.Once
	bundledRoot string
)

// ErrSupported reports a platform with no pinned runtime.
var ErrSupported = errors.New("FFmpeg setup is available on Windows x64 only")

// Supported reports whether this build has a pinned runtime it can install.
func Supported() bool { return runtime.GOOS == "windows" && runtime.GOARCH == "amd64" }

// ConfigureBundledRuntime names the directory a packaged build ships the
// runtime in. It takes effect once; later calls are ignored, so a caller
// cannot redirect an already-resolved runtime path.
func ConfigureBundledRuntime(resourceDir string) {
	bundledOnce.Do(func() { bundledRoot = filepath.Join(resourceDir, "ffmpeg") })
}

// AppRoot is the per-user application data directory.
func AppRoot() (string, error) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		// Off Windows there is no LOCALAPPDATA; os.UserConfigDir is the
		// equivalent and keeps the tests runnable everywhere.
		dir, err := os.UserConfigDir()
		if err != nil || dir == "" {
			return "", errors.New("Local application directory is unavailable")
		}
		local = dir
	}
	return filepath.Join(local, appDirName), nil
}

// InstallRoot is where this package installs the runtime.
func InstallRoot() (string, error) {
	root, err := AppRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, InstallDirName), nil
}

// RuntimePath returns the ffmpeg.exe this host should run, preferring a
// bundled copy over an installed one. Empty means no valid runtime.
func RuntimePath() string {
	if bundledRoot != "" && isInstalled(bundledRoot) {
		return filepath.Join(bundledRoot, executableName())
	}
	root, err := InstallRoot()
	if err != nil || !isInstalled(root) {
		return ""
	}
	return filepath.Join(root, executableName())
}

func executableName() string {
	if runtime.GOOS == "windows" {
		return "ffmpeg.exe"
	}
	return "ffmpeg"
}

// Info reports the current state of the runtime.
func Info() InstallInfo {
	supported := Supported()
	bundled := bundledRoot != "" && isInstalled(bundledRoot)
	installed := bundled
	if !installed {
		if root, err := InstallRoot(); err == nil {
			installed = isInstalled(root)
		}
	}

	detail := "Native sharing setup is available on Windows x64 only"
	switch {
	case bundled:
		detail = "Native sharing is ready. FFmpeg 8.1 is included with BetterComms"
	case installed:
		detail = "The private FFmpeg 8.1 runtime is ready for native sharing"
	case supported:
		detail = "Install the verified FFmpeg 8.1 runtime privately for BetterComms; Windows and other apps are not changed"
	}
	return InstallInfo{
		Supported:      supported,
		Installed:      installed,
		DownloadBytes:  archiveBytes,
		InstalledBytes: ffmpegBytes + licenseBytes,
		Detail:         detail,
	}
}

// isInstalled reports whether root holds a complete, correctly sized runtime.
func isInstalled(root string) bool {
	return installedWithSizes(root, ffmpegBytes, licenseBytes)
}

// installedWithSizes is the readiness rule, parameterised so it can be tested
// without materialising a 200 MB file.
func installedWithSizes(root string, ffmpegSize, licenseSize int64) bool {
	return validFile(filepath.Join(root, executableName()), ffmpegSize) &&
		validFile(filepath.Join(root, "LICENSE"), licenseSize) &&
		isRegularFile(filepath.Join(root, "setup.json"))
}

func validFile(path string, size int64) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() == size
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// Install downloads, verifies, and installs the pinned runtime.
//
// It is a no-op returning success when a valid runtime already exists, so the
// caller can invoke it without checking first.
func Install(ctx context.Context) (InstallResult, error) {
	if !installing.CompareAndSwap(false, true) {
		return InstallResult{}, errors.New("FFmpeg setup is already running")
	}
	defer installing.Store(false)

	if !Supported() {
		return InstallResult{}, ErrSupported
	}
	if RuntimePath() != "" {
		return InstallResult{Installed: true}, nil
	}
	destination, err := InstallRoot()
	if err != nil {
		return InstallResult{}, err
	}
	if isInstalled(destination) {
		return InstallResult{Installed: true}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()

	if err := install(ctx, destination); err != nil {
		return InstallResult{}, err
	}
	if !isInstalled(destination) {
		return InstallResult{}, errors.New("FFmpeg setup completed without a valid runtime")
	}
	return InstallResult{Installed: true}, nil
}

func install(ctx context.Context, destination string) error {
	parent, err := AppRoot()
	if err != nil {
		return err
	}
	if err := guardDestination(parent, destination); err != nil {
		return err
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("Could not create app data directory: %w", err)
	}
	// A reparse point here would let something outside the profile redirect
	// where a verified binary lands.
	for _, path := range []string{parent, destination} {
		reparse, err := isReparsePoint(path)
		if err == nil && reparse {
			return errors.New("FFmpeg setup directories cannot be reparse points")
		}
	}

	work, err := os.MkdirTemp(parent, "ffmpeg-install-*")
	if err != nil {
		return fmt.Errorf("Could not create FFmpeg setup workspace: %w", err)
	}
	defer func() { _ = os.RemoveAll(work) }()

	prepared := filepath.Join(work, "prepared")
	if err := os.MkdirAll(prepared, 0o755); err != nil {
		return fmt.Errorf("Could not stage the FFmpeg runtime: %w", err)
	}

	archive := filepath.Join(work, "ffmpeg.zip")
	if err := download(ctx, downloadURL, archive, archiveBytes); err != nil {
		return err
	}
	if err := verify(archive, archiveBytes, archiveSHA256); err != nil {
		return err
	}
	if err := extract(archive, prepared); err != nil {
		return err
	}
	if err := verify(filepath.Join(prepared, executableName()), ffmpegBytes, ffmpegSHA256); err != nil {
		return err
	}
	if err := verify(filepath.Join(prepared, "LICENSE"), licenseBytes, licenseSHA256); err != nil {
		return err
	}
	if err := probeGraphicsCapture(ctx, filepath.Join(prepared, executableName())); err != nil {
		return err
	}
	if err := writeSetupManifest(filepath.Join(prepared, "setup.json")); err != nil {
		return err
	}
	return swap(prepared, destination)
}

// guardDestination refuses any path but the one directory this package owns,
// so a caller cannot aim the install at an arbitrary location.
func guardDestination(parent, destination string) error {
	absParent, err := filepath.Abs(parent)
	if err != nil {
		return err
	}
	absDestination, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if filepath.Dir(absDestination) != absParent || filepath.Base(absDestination) != InstallDirName {
		return errors.New("Destination is outside the Bettercomms application data directory")
	}
	return nil
}

// download streams the archive, refusing anything whose advertised or actual
// length differs from the pinned size.
func download(ctx context.Context, url, path string, limit int64) error {
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("Could not prepare the FFmpeg download: %w", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("Could not download the FFmpeg runtime: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("FFmpeg download returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength >= 0 && response.ContentLength != limit {
		return errors.New("Pinned FFmpeg download length changed")
	}

	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("Could not write the FFmpeg download: %w", err)
	}
	defer func() { _ = file.Close() }()

	// Reading one byte past the pinned length is enough to know the body is
	// wrong, without buffering the overflow.
	written, err := io.Copy(file, io.LimitReader(response.Body, limit+1))
	if err != nil {
		return fmt.Errorf("Could not read the FFmpeg download: %w", err)
	}
	if written != limit {
		return errors.New("FFmpeg download did not match its pinned size")
	}
	return file.Close()
}

// verify checks a file against its pinned length and SHA-256.
func verify(path string, size int64, digest string) error {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != size {
		return fmt.Errorf("Runtime file failed its pinned length check: %s", filepath.Base(path))
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("Could not read %s: %w", filepath.Base(path), err)
	}
	defer func() { _ = file.Close() }()

	sum := sha256.New()
	if _, err := io.Copy(sum, file); err != nil {
		return fmt.Errorf("Could not hash %s: %w", filepath.Base(path), err)
	}
	if !strings.EqualFold(hex.EncodeToString(sum.Sum(nil)), digest) {
		return fmt.Errorf("Runtime file failed its pinned SHA-256 check: %s", filepath.Base(path))
	}
	return nil
}

// extract copies only the two pinned entries, by exact name, with a size cap
// applied before any bytes are written.
func extract(archive, prepared string) error {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return fmt.Errorf("Could not open the FFmpeg archive: %w", err)
	}
	defer func() { _ = reader.Close() }()

	for _, entry := range []struct {
		name   string
		output string
		cap    int64
	}{
		{ffmpegEntry, executableName(), ffmpegEntryCap},
		{licenseEntry, "LICENSE", licenseEntryCap},
	} {
		if err := copyEntry(&reader.Reader, entry.name, filepath.Join(prepared, entry.output), entry.cap); err != nil {
			return err
		}
	}
	return nil
}

func copyEntry(reader *zip.Reader, name, output string, limit int64) error {
	// Looked up by exact name rather than by walking, so a crafted archive
	// cannot substitute a path that merely looks similar.
	file, err := reader.Open(name)
	if err != nil {
		return fmt.Errorf("Pinned archive entry is missing: %s", name)
	}
	defer func() { _ = file.Close() }()

	info, err := file.Stat()
	if err != nil || info.Size() > limit {
		return fmt.Errorf("Pinned archive entry is missing or too large: %s", name)
	}

	destination, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return fmt.Errorf("Could not stage %s: %w", filepath.Base(output), err)
	}
	defer func() { _ = destination.Close() }()

	if _, err := io.Copy(destination, io.LimitReader(file, limit)); err != nil {
		return fmt.Errorf("Could not extract %s: %w", filepath.Base(output), err)
	}
	return destination.Close()
}

// probeGraphicsCapture refuses a build that cannot do what it is being
// installed for. A correct hash on the wrong feature set is still the wrong
// runtime.
func probeGraphicsCapture(ctx context.Context, executable string) error {
	probe, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	output, err := exec.CommandContext(probe, executable, "-hide_banner", "-filters").CombinedOutput()
	if err != nil {
		return fmt.Errorf("Pinned FFmpeg runtime could not be probed: %w", err)
	}
	if !strings.Contains(string(output), "gfxcapture") {
		return errors.New("Pinned FFmpeg runtime does not provide Windows Graphics Capture")
	}
	return nil
}

func writeSetupManifest(path string) error {
	manifest, err := json.MarshalIndent(map[string]any{
		"schemaVersion": 1,
		"version":       "8.1",
		"archiveSha256": archiveSHA256,
		"ffmpegSha256":  ffmpegSHA256,
		"source":        downloadURL,
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("Could not describe the FFmpeg runtime: %w", err)
	}
	if err := os.WriteFile(path, manifest, 0o644); err != nil {
		return fmt.Errorf("Could not record the FFmpeg runtime: %w", err)
	}
	return nil
}

// swap replaces the destination with the prepared directory, keeping the old
// one until the move succeeds so a failure leaves the previous runtime intact.
func swap(prepared, destination string) error {
	backup := destination + ".backup-" + fmt.Sprint(time.Now().UnixNano())
	restore := false
	if _, err := os.Stat(destination); err == nil {
		if err := os.Rename(destination, backup); err != nil {
			return fmt.Errorf("Could not replace the existing FFmpeg runtime: %w", err)
		}
		restore = true
	}
	if err := os.Rename(prepared, destination); err != nil {
		if restore {
			_ = os.RemoveAll(destination)
			_ = os.Rename(backup, destination)
		}
		return fmt.Errorf("Could not install the FFmpeg runtime: %w", err)
	}
	if restore {
		_ = os.RemoveAll(backup)
	}
	return nil
}
