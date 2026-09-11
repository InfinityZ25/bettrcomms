package nvidiaaudio

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// writeSetup builds an installation directory with a manifest.
func writeSetup(t *testing.T, manifest setupManifest, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, body := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "setup.json"), body, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	return root
}

// pointSetupAt makes resolveSetup find the given directory.
func pointSetupAt(t *testing.T, root string) {
	t.Helper()
	local := t.TempDir()
	target := filepath.Join(local, "Bettercomms", "nvidia-audio-effects")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Copy rather than symlink: the resolver deliberately follows symlinks, and
	// this is meant to look like a real install.
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var copyTree func(from, to string)
	copyTree = func(from, to string) {
		items, err := os.ReadDir(from)
		if err != nil {
			t.Fatalf("read %s: %v", from, err)
		}
		for _, item := range items {
			source := filepath.Join(from, item.Name())
			destination := filepath.Join(to, item.Name())
			if item.IsDir() {
				if err := os.MkdirAll(destination, 0o755); err != nil {
					t.Fatalf("mkdir: %v", err)
				}
				copyTree(source, destination)
				continue
			}
			body, err := os.ReadFile(source)
			if err != nil {
				t.Fatalf("read %s: %v", source, err)
			}
			if err := os.WriteFile(destination, body, 0o644); err != nil {
				t.Fatalf("write %s: %v", destination, err)
			}
		}
	}
	_ = entries
	copyTree(root, target)

	t.Setenv("LOCALAPPDATA", local)
	t.Setenv("BETTERCOMMS_REPO", "")
}

// The manifest is a file on disk. A file on disk is not a reason to load an
// arbitrary DLL, so every path in it is re-checked against its own directory.
func TestTrustedFileRefusesAnythingOutsideTheSetupDirectory(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "bin")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(inside, "NVAudioEffects.dll"), []byte("dll"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, err := trustedFile(root, "bin/NVAudioEffects.dll", "SDK DLL"); err != nil {
		t.Errorf("a file inside the setup directory was refused: %v", err)
	}

	for _, test := range []struct{ name, path string }{
		{"a traversal", "../NVAudioEffects.dll"},
		{"a nested traversal", "bin/../../NVAudioEffects.dll"},
		{"a POSIX absolute path", "/windows/system32/evil.dll"},
		{"a current-directory reference", "./bin/NVAudioEffects.dll"},
		{"an empty path", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := trustedFile(root, test.path, "SDK DLL"); err == nil {
				t.Errorf("%q was accepted", test.path)
			}
		})
	}
}

func TestTrustedFileRefusesWindowsAbsolutePaths(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows path forms")
	}
	root := t.TempDir()
	for _, path := range []string{
		`C:\Windows\System32\evil.dll`,
		`C:evil.dll`,
		`\\server\share\evil.dll`,
		`..\evil.dll`,
	} {
		if _, err := trustedFile(root, path, "SDK DLL"); err == nil {
			t.Errorf("%q was accepted", path)
		}
	}
}

// A sibling directory sharing a prefix is not inside the setup directory.
func TestWithinComparesWholeComponents(t *testing.T) {
	if within(filepath.FromSlash("/a/setup"), filepath.FromSlash("/a/setup-evil/x.dll")) {
		t.Error("a sibling with a shared prefix was treated as inside")
	}
	if !within(filepath.FromSlash("/a/setup"), filepath.FromSlash("/a/setup/bin/x.dll")) {
		t.Error("a real child was treated as outside")
	}
	if !within(filepath.FromSlash("/a/setup"), filepath.FromSlash("/a/setup")) {
		t.Error("the directory itself was treated as outside")
	}
}

func TestResolveSetupRequiresACompleteManifest(t *testing.T) {
	for _, test := range []struct {
		name     string
		manifest setupManifest
		files    map[string]string
	}{
		{
			name:     "an unsupported schema version",
			manifest: setupManifest{SchemaVersion: 2, SDKDLL: "NVAudioEffects.dll", Model: "denoiser.bin"},
			files:    map[string]string{"NVAudioEffects.dll": "dll", "denoiser.bin": "model"},
		},
		{
			name:     "a missing model",
			manifest: setupManifest{SchemaVersion: 1, SDKDLL: "NVAudioEffects.dll", Model: "denoiser.bin"},
			files:    map[string]string{"NVAudioEffects.dll": "dll"},
		},
		{
			name:     "a DLL under another name",
			manifest: setupManifest{SchemaVersion: 1, SDKDLL: "Something.dll", Model: "denoiser.bin"},
			files:    map[string]string{"Something.dll": "dll", "denoiser.bin": "model"},
		},
		{
			name:     "a DLL outside the directory",
			manifest: setupManifest{SchemaVersion: 1, SDKDLL: "../NVAudioEffects.dll", Model: "denoiser.bin"},
			files:    map[string]string{"denoiser.bin": "model"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			pointSetupAt(t, writeSetup(t, test.manifest, test.files))
			if _, _, err := resolveSetup(); err == nil {
				t.Error("accepted")
			}
		})
	}
}

func TestResolveSetupAcceptsAValidInstallation(t *testing.T) {
	pointSetupAt(t, writeSetup(t,
		setupManifest{SchemaVersion: 1, SDKDLL: "bin/NVAudioEffects.dll", Model: "models/denoiser.bin"},
		map[string]string{"bin/NVAudioEffects.dll": "dll", "models/denoiser.bin": "model"},
	))

	dll, model, err := resolveSetup()
	if err != nil {
		t.Fatalf("resolveSetup: %v", err)
	}
	if filepath.Base(dll) != sdkFileName {
		t.Errorf("dll = %q, want it to end in %s", dll, sdkFileName)
	}
	if filepath.Base(model) != "denoiser.bin" {
		t.Errorf("model = %q", model)
	}
}

func TestResolveSetupReportsNoInstallation(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("BETTERCOMMS_REPO", "")

	if _, _, err := resolveSetup(); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("err = %v, want ErrNotInstalled", err)
	}
}

func TestIntensityIsBounded(t *testing.T) {
	for _, valid := range []float32{0, 0.5, 1} {
		if _, err := validateIntensity(valid); err != nil {
			t.Errorf("%v was rejected: %v", valid, err)
		}
	}
	for _, invalid := range []float32{-0.1, 1.1, 100} {
		if _, err := validateIntensity(invalid); err == nil {
			t.Errorf("%v was accepted", invalid)
		}
	}
}

// Status must say what is wrong rather than merely reporting unavailable, and
// must not claim a GPU denoiser exists when nothing is installed.
func TestStatusReportsAnUninstalledMachine(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("BETTERCOMMS_REPO", "")

	engine := NewEngine()
	t.Cleanup(engine.Close)

	status := engine.Status()
	if status.Available {
		t.Error("an uninstalled machine reported the denoiser available")
	}
	if status.Detail == "" {
		t.Error("Status carries no explanation")
	}
	if runtime.GOOS == "windows" && status.Installed {
		t.Error("an empty directory reported an installation")
	}
}

func TestProcessBeforeStartFails(t *testing.T) {
	engine := NewEngine()
	t.Cleanup(engine.Close)

	if _, err := engine.Process(make([]float32, 480)); err == nil {
		t.Error("processing succeeded before the engine was started")
	} else if !strings.Contains(err.Error(), "not running") {
		t.Errorf("err = %v, want the not-running reason", err)
	}
}

func TestStopAndCloseAreSafeWhenNothingIsLoaded(t *testing.T) {
	engine := NewEngine()
	engine.Stop()
	engine.Close()
	engine.Close()
}

// The pinned package is the Ada build. NVIDIA ships a different package per
// architecture, and the wrong one loads and then fails inside the model, so a
// card is checked before anyone is offered a several-hundred-megabyte download.
func TestOnlyAdaCardsMatchThePinnedPackage(t *testing.T) {
	for _, name := range []string{
		"NVIDIA GeForce RTX 4090",
		"NVIDIA GeForce RTX 4060 Laptop GPU",
		"NVIDIA RTX 4000 Ada Generation",
		"NVIDIA RTX 5880 Ada Generation",
	} {
		if !SupportsPinnedPackage(name) {
			t.Errorf("%q was rejected", name)
		}
	}

	for _, name := range []string{
		"NVIDIA GeForce RTX 3090",
		"NVIDIA GeForce RTX 2080 Ti",
		"NVIDIA GeForce GTX 1080",
		"NVIDIA RTX A4000",
		"AMD Radeon(TM) Graphics",
		"Intel(R) Arc(TM) A770 Graphics",
		"Microsoft Basic Render Driver",
		"",
	} {
		if SupportsPinnedPackage(name) {
			t.Errorf("%q was accepted", name)
		}
	}
}

// Describe has to be honest on a machine like this one, and say what runs
// instead rather than only that something is missing.
func TestDescribeExplainsThisMachine(t *testing.T) {
	info := Describe()

	if info.SchemaVersion != 1 {
		t.Errorf("schema version %d", info.SchemaVersion)
	}
	if info.Detail == "" {
		t.Fatal("Describe carries no explanation")
	}
	if info.Supported && info.Package == "" {
		t.Error("a supported machine was not told which package to install")
	}
	if !info.Supported && info.Package != "" {
		t.Error("an unsupported machine was offered a package")
	}
	t.Logf("supported=%v installed=%v gpu=%q detail=%s",
		info.Supported, info.Installed, info.GPUName, info.Detail)
}

// The install root is the one place that decides where a package must go, and
// whoever unpacks it needs an answer that is not a guess.
func TestTheInstallRootIsUnderTheAppsOwnData(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the install root is a Windows path")
	}
	t.Setenv("LOCALAPPDATA", filepath.Join("C:", "Users", "someone", "AppData", "Local"))

	root, err := InstallRoot()
	if err != nil {
		t.Fatalf("InstallRoot: %v", err)
	}
	want := filepath.Join("C:", "Users", "someone", "AppData", "Local", "Bettercomms", "nvidia-audio-effects")
	if root != want {
		t.Errorf("InstallRoot = %q, want %q", root, want)
	}

	t.Setenv("LOCALAPPDATA", "")
	if _, err := InstallRoot(); err == nil {
		t.Error("a machine with no LOCALAPPDATA reported an install root")
	}
}
