package dspsetup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestEmbeddedAssetsMatchTauriSources(t *testing.T) {
	repo := filepath.Join("..", "..", "..", "..", "..")
	for _, name := range []string{"install-deepfilter.ps1", "install-nvidia-audio.ps1"} {
		source, err := os.ReadFile(filepath.Join(repo, "scripts", name))
		if err != nil {
			t.Fatal(err)
		}
		copy, err := assets.ReadFile("assets/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(source, copy) {
			t.Fatalf("stale installer %s; run stage-wails-native-assets.ps1", name)
		}
	}
	entries, err := assets.ReadDir("assets/deepfilter")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 8 {
		t.Fatal("model or licence missing")
	}
	for _, entry := range entries {
		name := entry.Name()
		source, err := os.ReadFile(filepath.Join(repo, "apps", "desktop", "src-tauri", "resources", "deepfilter", name))
		if err != nil {
			t.Fatal(err)
		}
		copy, err := assets.ReadFile("assets/deepfilter/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(source, copy) {
			t.Fatalf("stale model asset %s", name)
		}
	}
	model, _ := assets.ReadFile("assets/deepfilter/denoiser_model.onnx")
	if fmt.Sprintf("%x", sha256.Sum256(model)) != "41ab21252f5357d3ff29999ba37d7b529bcbbb60d3b7e2b8d720726185bb4740" {
		t.Fatal("model hash differs from pinned installer")
	}
}

func TestReadinessRequiresEveryFileIncludingNotices(t *testing.T) {
	root := t.TempDir()
	r := recipes["deepfilter"]
	for _, name := range r.required {
		if ready(root, r.required) {
			t.Fatalf("declared ready before %s", name)
		}
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if !ready(root, r.required) {
		t.Fatal("complete fixture not detected")
	}
}

func TestInstallerRejectsUnknownAndCancelledRequests(t *testing.T) {
	if _, err := Install(context.Background(), "other"); err == nil {
		t.Fatal("unknown installer allowed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Install(ctx, "deepfilter"); err != context.Canceled {
		t.Fatalf("cancelled install: %v", err)
	}
	if _, err := Install(ctx, "nvidia"); err != context.Canceled {
		t.Fatalf("cancelled install leaked lock: %v", err)
	}
}
