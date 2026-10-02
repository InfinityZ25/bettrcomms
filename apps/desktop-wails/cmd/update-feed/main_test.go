package main

import (
	"bettercomms/desktop-wails/internal/desktop/updates"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestToolSignsFinalArtifactAndCannotOverwritePrivateKey(t *testing.T) {
	directory := t.TempDir()
	keyPath := filepath.Join(directory, "private.pem")
	if err := run(keyPath, true, "", "", ""); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := run(keyPath, true, "", "", ""); err == nil {
		t.Fatal("key replacement allowed")
	}
	after, _ := os.ReadFile(keyPath)
	if string(before) != string(after) {
		t.Fatal("existing key changed")
	}
	block, _ := pem.Decode(before)
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	public := parsed.(ed25519.PrivateKey).Public().(ed25519.PublicKey)
	content := []byte("final already-OS-signed artifact bytes")
	filename := "bettercomms-0.2.0-update.exe"
	if err := os.WriteFile(filepath.Join(directory, filename), content, 0600); err != nil {
		t.Fatal(err)
	}
	manifest := updates.Manifest{Schema: 1, Version: "0.2.0", Channel: "stable", PublishedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(time.Hour), Artifacts: []updates.Artifact{
		{Platform: "windows", Arch: "amd64", Filename: filename, URL: "https://updates.example.test/" + filename},
	}}
	raw, _ := json.Marshal(manifest)
	manifestPath, outputPath := filepath.Join(directory, "input.json"), filepath.Join(directory, "stable.json")
	if err := os.WriteFile(manifestPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := run(keyPath, false, manifestPath, directory, outputPath); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(outputPath)
	var envelope updates.Envelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	payload, _ := base64.StdEncoding.DecodeString(envelope.Payload)
	signature, _ := base64.StdEncoding.DecodeString(envelope.Signature)
	if !ed25519.Verify(public, payload, signature) {
		t.Fatal("manifest signature invalid")
	}
	if err := json.Unmarshal(payload, &manifest); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	signature, _ = base64.StdEncoding.DecodeString(manifest.Artifacts[0].Signature)
	if manifest.Artifacts[0].Size != int64(len(content)) || !ed25519.Verify(public, digest[:], signature) {
		t.Fatal("artifact does not match final signed bytes")
	}
	changed := append([]byte(nil), payload...)
	changed[len(changed)-1] ^= 1
	signature, _ = base64.StdEncoding.DecodeString(envelope.Signature)
	if ed25519.Verify(public, changed, signature) {
		t.Fatal("changed manifest accepted")
	}
}
