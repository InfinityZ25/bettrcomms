package ffmpegsetup

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBundledRuntimeConfigurationCannotBeRedirected(t *testing.T) {
	previous := bundledRoot
	bundledOnce = sync.Once{}
	t.Cleanup(func() { bundledRoot = previous; bundledOnce = sync.Once{} })
	root := t.TempDir()
	ConfigureBundledRuntime(root)
	ConfigureBundledRuntime(t.TempDir())
	if bundledRoot != filepath.Join(root, "ffmpeg") {
		t.Fatalf("runtime redirected to %q", bundledRoot)
	}
}

// Explicit opt-in: exercises the staged release runtime, not a developer's
// existing private install. Run after scripts/stage-wails-ffmpeg.ps1.
func TestStagedBundleRunsWithoutPrivateInstall(t *testing.T) {
	root := os.Getenv("BETTERCOMMS_TEST_BUNDLE_DIR")
	if root == "" {
		t.Skip("set BETTERCOMMS_TEST_BUNDLE_DIR to the staged Wails bin directory")
	}
	if !Supported() {
		t.Skip("the pinned bundle targets Windows x64")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		t.Fatal(err)
	}
	previous := bundledRoot
	bundledOnce = sync.Once{}
	t.Cleanup(func() { bundledRoot = previous; bundledOnce = sync.Once{} })
	t.Setenv("LOCALAPPDATA", t.TempDir())
	ConfigureBundledRuntime(root)
	expected := filepath.Join(root, "ffmpeg", "ffmpeg.exe")
	if got := RuntimePath(); got != expected {
		t.Fatalf("runtime = %q, want packaged %q", got, expected)
	}
	if report := Info(); !report.Installed || !strings.Contains(report.Detail, "included") {
		t.Fatalf("packaged runtime not reported: %+v", report)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, expected, "-version")
	command.Dir = t.TempDir()
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("packaged runtime failed from unrelated directory: %v", err)
	}
	if !strings.Contains(string(output), "ffmpeg version 8.1") {
		t.Fatal("packaged runtime did not report FFmpeg 8.1")
	}
}
