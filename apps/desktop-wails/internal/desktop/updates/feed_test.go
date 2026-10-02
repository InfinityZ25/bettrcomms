package updates

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (*Provider, ed25519.PrivateKey, Manifest) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	provider, err := NewProvider("https://updates.example.test/feed.json", base64.StdEncoding.EncodeToString(public), "cdn.example.test", filepath.Join(t.TempDir(), "floor"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	provider.now = func() time.Time { return now }
	digest := sha256.Sum256([]byte("native update"))
	artifact := Artifact{Platform: "windows", Arch: "amd64", Filename: "bettercomms-0.2.0-update.exe", URL: "https://cdn.example.test/update.exe", Size: 13, SHA256: hex.EncodeToString(digest[:]), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, digest[:]))}
	return provider, private, Manifest{Schema: 1, Version: "0.2.0", Channel: "stable", PublishedAt: now, ExpiresAt: now.Add(24 * time.Hour), Artifacts: []Artifact{artifact}}
}
func signed(t *testing.T, private ed25519.PrivateKey, manifest Manifest) []byte {
	t.Helper()
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(Envelope{Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))})
	if err != nil {
		t.Fatal(err)
	}
	return envelope
}
func request() updater.CheckRequest {
	return updater.CheckRequest{CurrentVersion: "0.1.19", Platform: "windows", Arch: "amd64"}
}
func TestSignedMetadataAndAntiRollback(t *testing.T) {
	provider, private, manifest := fixture(t)
	release, err := provider.release(signed(t, private, manifest), request())
	if err != nil || release.Verification == nil || len(release.Verification.Signature) != 64 {
		t.Fatalf("verified release %v %v", release, err)
	}
	manifest.Version = "0.1.20"
	if _, err := provider.release(signed(t, private, manifest), request()); err == nil {
		t.Fatal("rollback below highest accepted version allowed")
	}
	restored, err := NewProvider(provider.feed, base64.StdEncoding.EncodeToString(provider.key), "cdn.example.test", provider.floorPath)
	if err != nil || restored.highest != "0.2.0" {
		t.Fatalf("rollback floor not persisted %v", err)
	}
}
func TestUntrustedOrInvalidMetadataFailsClosed(t *testing.T) {
	for name, change := range map[string]func(*Manifest){
		"expired":           func(m *Manifest) { m.ExpiresAt = time.Now().Add(-time.Hour) },
		"future":            func(m *Manifest) { m.PublishedAt = time.Now().Add(time.Hour) },
		"long expiry":       func(m *Manifest) { m.ExpiresAt = time.Now().Add(90 * 24 * time.Hour) },
		"downgrade":         func(m *Manifest) { m.Version = "0.1.1" },
		"invalid version":   func(m *Manifest) { m.Version = "wails-v0.2.0" },
		"wrong platform":    func(m *Manifest) { m.Artifacts[0].Platform = "darwin" },
		"duplicate":         func(m *Manifest) { m.Artifacts = append(m.Artifacts, m.Artifacts[0]) },
		"unsigned artifact": func(m *Manifest) { m.Artifacts[0].Signature = "" },
		"untrusted host":    func(m *Manifest) { m.Artifacts[0].URL = "https://attacker.example.test/update.exe" },
		"http":              func(m *Manifest) { m.Artifacts[0].URL = "http://cdn.example.test/update.exe" },
		"credentials":       func(m *Manifest) { m.Artifacts[0].URL = "https://user:pass@cdn.example.test/update.exe" },
		"oversize":          func(m *Manifest) { m.Artifacts[0].Size = MaxArtifactSize + 1 },
		"traversal":         func(m *Manifest) { m.Artifacts[0].Filename = "../update.exe" },
		"installer":         func(m *Manifest) { m.Artifacts[0].Filename = "bettercomms-setup.exe" },
	} {
		t.Run(name, func(t *testing.T) {
			p, key, m := fixture(t)
			change(&m)
			if _, err := p.release(signed(t, key, m), request()); err == nil {
				t.Fatal("invalid metadata accepted")
			}
		})
	}
	provider, key, m := fixture(t)
	envelope := signed(t, key, m)
	envelope[len(envelope)-4] ^= 1
	if _, err := provider.release(envelope, request()); err == nil {
		t.Fatal("tampered manifest accepted")
	}
	_, other, _ := fixture(t)
	if _, err := provider.release(signed(t, other, m), request()); err == nil {
		t.Fatal("feed selected its own signing key")
	}
}

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestDownloadIsBoundedAndRejectsTruncation(t *testing.T) {
	for _, content := range []string{"native update", "native update appended", "native"} {
		p, key, m := fixture(t)
		release, err := p.release(signed(t, key, m), request())
		if err != nil {
			t.Fatal(err)
		}
		p.client = &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(content)), ContentLength: -1}, nil
		})}
		var destination bytes.Buffer
		err = p.Download(context.Background(), release, &destination, func(int64, int64) {})
		if (err == nil) != (content == "native update") {
			t.Fatalf("content %q error %v", content, err)
		}
		if destination.Len() > 13 {
			t.Fatal("more than signed bytes written")
		}
	}
}
func TestStagedBytesMustStillMatchBeforeRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update.exe")
	data := []byte("signed bytes")
	digest := sha256.Sum256(data)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyDigest(path, digest[:]); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("modified"), 0600); err != nil {
		t.Fatal(err)
	}
	if VerifyDigest(path, digest[:]) == nil {
		t.Fatal("modified staged bytes accepted")
	}
}
func TestUnsignedPlatformArtifactIsNeverAccepted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unsigned.exe")
	if err := os.WriteFile(path, []byte("not a signed native package"), 0600); err != nil {
		t.Fatal(err)
	}
	if VerifyPlatformSignature(path, "") == nil {
		t.Fatal("unsigned native update accepted")
	}
}
