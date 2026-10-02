// Package updates requires signed release metadata and signed bounded artifacts.
// The feed cannot change the embedded public key or allowed download hosts.
package updates

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const MaxArtifactSize = 300 << 20
const maxFeedSize = 256 << 10

type Envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type Manifest struct {
	Schema      int        `json:"schema"`
	Version     string     `json:"version"`
	Channel     string     `json:"channel"`
	PublishedAt time.Time  `json:"publishedAt"`
	ExpiresAt   time.Time  `json:"expiresAt"`
	Notes       string     `json:"notes"`
	Artifacts   []Artifact `json:"artifacts"`
}
type Artifact struct {
	Platform  string `json:"platform"`
	Arch      string `json:"arch"`
	Filename  string `json:"filename"`
	URL       string `json:"url"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	Signature string `json:"signature"`
}
type Provider struct {
	feed      string
	key       ed25519.PublicKey
	hosts     map[string]bool
	client    *http.Client
	floorPath string
	mu        sync.Mutex
	highest   string
	now       func() time.Time
}

func NewProvider(feed, publicKey, allowedHosts, floorPath string) (*Provider, error) {
	key, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("Updates require a build-time Ed25519 public key")
	}
	parsed, err := url.Parse(feed)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" || parsed.Port() != "" && parsed.Port() != "443" {
		return nil, errors.New("Updates require a configured HTTPS feed")
	}
	hosts := map[string]bool{strings.ToLower(parsed.Hostname()): true}
	for _, host := range strings.Split(allowedHosts, ",") {
		host = strings.TrimSpace(strings.ToLower(host))
		if host == "" {
			continue
		}
		if strings.ContainsAny(host, "/:@?# \\") {
			return nil, errors.New("Invalid configured update download hostname")
		}
		hosts[host] = true
	}
	p := &Provider{feed: feed, key: key, hosts: hosts, floorPath: floorPath, now: time.Now}
	p.client = &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 || !p.allowedURL(req.URL) {
			return errors.New("Update redirect is not allowed")
		}
		return nil
	}}
	if floorPath != "" {
		bytes, err := os.ReadFile(floorPath)
		if err == nil {
			p.highest = strings.TrimSpace(string(bytes))
			if _, err := versionParts(p.highest); err != nil {
				return nil, errors.New("Saved update version is invalid")
			}
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("Could not read update downgrade protection")
		}
	}
	return p, nil
}
func (p *Provider) Name() string      { return "bettercomms-signed-feed" }
func (p *Provider) PublicKey() []byte { return append([]byte(nil), p.key...) }
func (p *Provider) allowedURL(u *url.URL) bool {
	return u.Scheme == "https" && u.User == nil && u.Fragment == "" && (u.Port() == "" || u.Port() == "443") && p.hosts[strings.ToLower(u.Hostname())]
}
func versionParts(version string) ([3]uint64, error) {
	var result [3]uint64
	parts := strings.Split(version, ".")
	if len(parts) != 3 {
		return result, errors.New("Invalid release version")
	}
	for i, part := range parts {
		if part == "" || len(part) > 1 && part[0] == '0' {
			return result, errors.New("Invalid release version")
		}
		for _, c := range part {
			if c < '0' || c > '9' {
				return result, errors.New("Invalid release version")
			}
		}
		n, err := strconv.ParseUint(part, 10, 32)
		if err != nil {
			return result, errors.New("Invalid release version")
		}
		result[i] = n
	}
	return result, nil
}
func CompareVersion(a, b string) (int, error) {
	aa, err := versionParts(a)
	if err != nil {
		return 0, err
	}
	bb, err := versionParts(b)
	if err != nil {
		return 0, err
	}
	for i := range aa {
		if aa[i] < bb[i] {
			return -1, nil
		}
		if aa[i] > bb[i] {
			return 1, nil
		}
	}
	return 0, nil
}
func (p *Provider) Check(ctx context.Context, req updater.CheckRequest) (*updater.Release, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, p.feed, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return nil, errors.New("The update feed could not be reached")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Update feed returned HTTP %d", response.StatusCode)
	}
	bytes, err := io.ReadAll(io.LimitReader(response.Body, maxFeedSize+1))
	if err != nil || len(bytes) > maxFeedSize {
		return nil, errors.New("Update metadata exceeds its limit")
	}
	return p.release(bytes, req)
}
func (p *Provider) release(bytes []byte, req updater.CheckRequest) (*updater.Release, error) {
	var envelope Envelope
	if len(bytes) > maxFeedSize || json.Unmarshal(bytes, &envelope) != nil {
		return nil, errors.New("Invalid update envelope")
	}
	payload, err := base64.StdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return nil, errors.New("Invalid signed update payload")
	}
	signature, err := base64.StdEncoding.DecodeString(envelope.Signature)
	if err != nil || !ed25519.Verify(p.key, payload, signature) {
		return nil, errors.New("Update manifest signature is invalid")
	}
	var manifest Manifest
	if json.Unmarshal(payload, &manifest) != nil || manifest.Schema != 1 || manifest.Channel != "stable" || len(manifest.Notes) > 8192 || len(manifest.Artifacts) > 8 {
		return nil, errors.New("Unsupported update manifest")
	}
	now := p.now()
	if manifest.PublishedAt.IsZero() || manifest.PublishedAt.After(now.Add(5*time.Minute)) || !manifest.ExpiresAt.After(now) || manifest.ExpiresAt.After(now.Add(31*24*time.Hour)) || !manifest.ExpiresAt.After(manifest.PublishedAt) {
		return nil, errors.New("Update metadata has expired or has invalid dates")
	}
	newer, err := CompareVersion(manifest.Version, req.CurrentVersion)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.highest != "" {
		cmp, err := CompareVersion(manifest.Version, p.highest)
		if err != nil || cmp < 0 {
			return nil, errors.New("Update downgrade rejected")
		}
	}
	if newer < 0 {
		return nil, errors.New("Update downgrade rejected")
	}
	if newer == 0 {
		return nil, nil
	}
	var selected *Artifact
	for i := range manifest.Artifacts {
		a := &manifest.Artifacts[i]
		if a.Platform == req.Platform && a.Arch == req.Arch {
			if selected != nil {
				return nil, errors.New("Ambiguous update artifact")
			}
			selected = a
		}
	}
	if selected == nil {
		return nil, errors.New("This release has no update for your platform")
	}
	a := *selected
	format := ".exe"
	if req.Platform == "darwin" {
		format = ".zip"
	} else if req.Platform != "windows" {
		return nil, errors.New("Updates are unavailable on this platform")
	}
	if a.Filename == "" || filepath.Base(a.Filename) != a.Filename || strings.ContainsAny(a.Filename, "/\\\x00") || !strings.HasSuffix(a.Filename, format) || strings.Contains(strings.ToLower(a.Filename), "setup") || a.Size <= 0 || a.Size > MaxArtifactSize {
		return nil, errors.New("Invalid update artifact")
	}
	downloadURL, err := url.Parse(a.URL)
	if err != nil || !p.allowedURL(downloadURL) {
		return nil, errors.New("Update download host is not allowed")
	}
	digest, err := hex.DecodeString(a.SHA256)
	if err != nil || len(digest) != sha256.Size {
		return nil, errors.New("Invalid update digest")
	}
	artifactSignature, err := base64.StdEncoding.DecodeString(a.Signature)
	if err != nil || !ed25519.Verify(p.key, digest, artifactSignature) {
		return nil, errors.New("Update artifact signature is invalid")
	}
	if p.floorPath != "" {
		if err := os.MkdirAll(filepath.Dir(p.floorPath), 0700); err != nil {
			return nil, errors.New("Could not save update downgrade protection")
		}
		temporary := p.floorPath + ".tmp"
		if err := os.WriteFile(temporary, []byte(manifest.Version), 0600); err != nil {
			return nil, errors.New("Could not save update downgrade protection")
		}
		if err := os.Rename(temporary, p.floorPath); err != nil {
			_ = os.Remove(temporary)
			return nil, errors.New("Could not save update downgrade protection")
		}
	}
	p.highest = manifest.Version
	return &updater.Release{Version: manifest.Version, Channel: "stable", Notes: manifest.Notes, PublishedAt: manifest.PublishedAt,
		Artifact:     updater.Artifact{Filename: a.Filename, Size: a.Size, Platform: a.Platform, Arch: a.Arch},
		Verification: &updater.Verification{DigestAlgo: "sha256", Digest: digest, SignatureAlgo: "ed25519", Signature: artifactSignature},
		Metadata:     map[string]any{"url": a.URL, "expiresAt": manifest.ExpiresAt.Format(time.RFC3339Nano)}}, nil
}
func (p *Provider) Download(ctx context.Context, release *updater.Release, destination io.Writer, progress func(int64, int64)) error {
	if release == nil {
		return errors.New("Missing verified release")
	}
	raw, ok := release.Metadata["url"].(string)
	if !ok {
		return errors.New("Missing verified download URL")
	}
	parsed, err := url.Parse(raw)
	if err != nil || !p.allowedURL(parsed) {
		return errors.New("Update download host is not allowed")
	}
	if release.Verification == nil || release.Verification.SignatureAlgo != "ed25519" || !ed25519.Verify(p.key, release.Verification.Digest, release.Verification.Signature) || release.Artifact.Size <= 0 || release.Artifact.Size > MaxArtifactSize {
		return errors.New("Unsigned or invalid update rejected")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return err
	}
	response, err := p.client.Do(request)
	if err != nil {
		return errors.New("Update could not be downloaded")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > release.Artifact.Size {
		return errors.New("Unexpected update download response")
	}
	reader := io.LimitReader(response.Body, release.Artifact.Size+1)
	buffer := make([]byte, 64<<10)
	var written int64
	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			if written+int64(n) > release.Artifact.Size {
				return errors.New("Update exceeds its signed size")
			}
			count, err := destination.Write(buffer[:n])
			written += int64(count)
			if err != nil {
				return err
			}
			if count != n {
				return io.ErrShortWrite
			}
			progress(written, release.Artifact.Size)
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if written != release.Artifact.Size {
		return errors.New("Update download is incomplete")
	}
	return nil
}
