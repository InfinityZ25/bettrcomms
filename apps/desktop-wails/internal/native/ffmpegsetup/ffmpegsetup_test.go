package ffmpegsetup

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func digestOf(t *testing.T, data []byte) string {
	t.Helper()
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Readiness needs every pinned file. A partial directory is not a runtime, and
// treating it as one would hand a half-installed binary to native sharing.
func TestReadinessRequiresEveryPinnedRuntimeFile(t *testing.T) {
	root := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	write(executableName(), "exe")
	write("LICENSE", "license")
	write("setup.json", "{}")

	if !installedWithSizes(root, 3, 7) {
		t.Fatal("a complete runtime was reported as missing")
	}
	if err := os.Remove(filepath.Join(root, "LICENSE")); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if installedWithSizes(root, 3, 7) {
		t.Error("a runtime missing its LICENSE was reported as ready")
	}
}

// A file of the right name but the wrong length is not the pinned runtime.
func TestReadinessRejectsAWrongLengthBinary(t *testing.T) {
	root := t.TempDir()
	for name, body := range map[string]string{
		executableName(): "exe-but-longer",
		"LICENSE":        "license",
		"setup.json":     "{}",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if installedWithSizes(root, 3, 7) {
		t.Error("a wrong-length binary was accepted")
	}
}

func TestGuardDestinationAcceptsOnlyTheOwnedDirectory(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "Bettercomms")
	for _, test := range []struct {
		name        string
		destination string
		wantErr     bool
	}{
		{"the owned directory", filepath.Join(parent, InstallDirName), false},
		{"a sibling name", filepath.Join(parent, "ffmpeg-9.0"), true},
		{"a nested path", filepath.Join(parent, InstallDirName, "inner"), true},
		{"outside the parent", filepath.Join(t.TempDir(), InstallDirName), true},
		{"a traversal", filepath.Join(parent, "..", InstallDirName), true},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := guardDestination(parent, test.destination)
			if (err != nil) != test.wantErr {
				t.Errorf("err = %v, wantErr = %v", err, test.wantErr)
			}
		})
	}
}

func TestVerifyChecksLengthAndDigest(t *testing.T) {
	body := []byte("pinned runtime bytes")
	path := filepath.Join(t.TempDir(), "artifact")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	good := digestOf(t, body)

	if err := verify(path, int64(len(body)), good); err != nil {
		t.Errorf("a matching file was rejected: %v", err)
	}
	if err := verify(path, int64(len(body))+1, good); err == nil {
		t.Error("a wrong length was accepted")
	} else if !strings.Contains(err.Error(), "pinned length") {
		t.Errorf("err = %v, want a length failure", err)
	}
	if err := verify(path, int64(len(body)), strings.Repeat("0", 64)); err == nil {
		t.Error("a wrong digest was accepted")
	} else if !strings.Contains(err.Error(), "SHA-256") {
		t.Errorf("err = %v, want a digest failure", err)
	}
	if err := verify(filepath.Join(t.TempDir(), "absent"), 1, good); err == nil {
		t.Error("a missing file was accepted")
	}
}

// buildArchive writes a zip holding the two pinned entry names.
func buildArchive(t *testing.T, ffmpeg, license []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ffmpeg.zip")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create archive: %v", err)
	}
	defer func() { _ = file.Close() }()

	writer := zip.NewWriter(file)
	for name, body := range map[string][]byte{ffmpegEntry: ffmpeg, licenseEntry: license} {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatalf("create entry %s: %v", name, err)
		}
		if _, err := entry.Write(body); err != nil {
			t.Fatalf("write entry %s: %v", name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close archive: %v", err)
	}
	return path
}

func TestExtractTakesOnlyThePinnedEntries(t *testing.T) {
	archive := buildArchive(t, []byte("binary"), []byte("terms"))
	prepared := t.TempDir()

	if err := extract(archive, prepared); err != nil {
		t.Fatalf("extract: %v", err)
	}
	binary, err := os.ReadFile(filepath.Join(prepared, executableName()))
	if err != nil || string(binary) != "binary" {
		t.Errorf("extracted binary = %q, err = %v", binary, err)
	}
	license, err := os.ReadFile(filepath.Join(prepared, "LICENSE"))
	if err != nil || string(license) != "terms" {
		t.Errorf("extracted license = %q, err = %v", license, err)
	}

	entries, err := os.ReadDir(prepared)
	if err != nil {
		t.Fatalf("read prepared: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("prepared holds %d files, want exactly the two pinned ones", len(entries))
	}
}

func TestExtractRefusesAnArchiveMissingAPinnedEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "partial.zip")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	writer := zip.NewWriter(file)
	entry, err := writer.Create(licenseEntry)
	if err != nil {
		t.Fatalf("create entry: %v", err)
	}
	if _, err := entry.Write([]byte("terms")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = writer.Close()
	_ = file.Close()

	if err := extract(path, t.TempDir()); err == nil {
		t.Error("an archive with no ffmpeg entry was accepted")
	}
}

func TestDownloadRefusesABodyThatIsNotThePinnedLength(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
		// advertise a Content-Length that lies about the body
		lie bool
	}{
		{name: "a short body", body: "tiny"},
		{name: "a long body", body: strings.Repeat("x", 64)},
		{name: "a lying Content-Length", body: strings.Repeat("x", 8), lie: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if test.lie {
					w.Header().Set("Content-Length", "16")
				}
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()

			path := filepath.Join(t.TempDir(), "download")
			if err := download(context.Background(), server.URL, path, 16); err == nil {
				t.Error("a body that did not match the pinned length was accepted")
			}
		})
	}
}

func TestDownloadAcceptsThePinnedLength(t *testing.T) {
	body := strings.Repeat("x", 16)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, body)
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "download")
	if err := download(context.Background(), server.URL, path, 16); err != nil {
		t.Fatalf("download: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != body {
		t.Errorf("downloaded %q, err = %v", got, err)
	}
}

func TestDownloadReportsAnHTTPFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	err := download(context.Background(), server.URL, filepath.Join(t.TempDir(), "download"), 16)
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("err = %v, want the status", err)
	}
}

// A failed swap must leave the previous runtime in place rather than deleting
// it and installing nothing.
func TestSwapReplacesAndKeepsNoBackupBehind(t *testing.T) {
	root := t.TempDir()
	prepared := filepath.Join(root, "prepared")
	destination := filepath.Join(root, InstallDirName)
	for _, dir := range []string{prepared, destination} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(prepared, "marker"), []byte("new"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(destination, "marker"), []byte("old"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	if err := swap(prepared, destination); err != nil {
		t.Fatalf("swap: %v", err)
	}
	marker, err := os.ReadFile(filepath.Join(destination, "marker"))
	if err != nil || string(marker) != "new" {
		t.Errorf("marker = %q, err = %v, want the new runtime", marker, err)
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read root: %v", err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".backup-") {
			t.Errorf("a backup was left behind: %s", entry.Name())
		}
	}
}

func TestWriteSetupManifestRecordsThePinnedIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "setup.json")
	if err := writeSetupManifest(path); err != nil {
		t.Fatalf("writeSetupManifest: %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var manifest struct {
		SchemaVersion int    `json:"schemaVersion"`
		Version       string `json:"version"`
		FFmpegSHA256  string `json:"ffmpegSha256"`
		Source        string `json:"source"`
	}
	if err := json.Unmarshal(body, &manifest); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if manifest.SchemaVersion != 1 || manifest.Version != "8.1" {
		t.Errorf("manifest = %+v", manifest)
	}
	if manifest.FFmpegSHA256 != ffmpegSHA256 || manifest.Source != downloadURL {
		t.Errorf("manifest does not record what was installed: %+v", manifest)
	}
}

// Install refuses to run twice at once. Two installs share a destination and
// would race on the swap.
func TestInstallIsSingleFlight(t *testing.T) {
	if !installing.CompareAndSwap(false, true) {
		t.Fatal("the gate was already held")
	}
	defer installing.Store(false)

	if _, err := Install(context.Background()); err == nil {
		t.Error("a concurrent install was allowed")
	} else if !strings.Contains(err.Error(), "already running") {
		t.Errorf("err = %v, want the concurrency reason", err)
	}
}

func TestInfoDescribesAnUninstalledMachine(t *testing.T) {
	// AppRoot follows the environment, so point it somewhere empty.
	t.Setenv("LOCALAPPDATA", t.TempDir())

	info := Info()
	if info.Installed {
		t.Error("an empty directory reported an installed runtime")
	}
	if info.DownloadBytes != archiveBytes || info.InstalledBytes != ffmpegBytes+licenseBytes {
		t.Errorf("info = %+v, want the pinned sizes", info)
	}
	if info.Detail == "" {
		t.Error("info carries no explanation")
	}
}
