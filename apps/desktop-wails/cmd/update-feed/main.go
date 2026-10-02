// update-feed signs release metadata without publishing or printing private keys.
package main

import (
	"bettercomms/desktop-wails/internal/desktop/updates"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func main() {
	keyPath := flag.String("key", "", "Ed25519 PKCS8 PEM private key")
	generate := flag.Bool("generate-key", false, "Create the private key once; never prints it")
	manifestPath := flag.String("manifest", "", "Unsigned manifest JSON with artifact metadata")
	directory := flag.String("artifacts", "", "Directory holding artifact filenames")
	output := flag.String("out", "", "Signed envelope output")
	flag.Parse()
	if err := run(*keyPath, *generate, *manifestPath, *directory, *output); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(keyPath string, generate bool, manifestPath, directory, output string) error {
	if keyPath == "" {
		return errors.New("Pass a private key path outside tracked files")
	}
	if generate {
		public, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		encoded, err := x509.MarshalPKCS8PrivateKey(private)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(keyPath), 0700); err != nil {
			return err
		}
		file, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, err = file.Write(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}))
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		fmt.Println("Public key:", base64.StdEncoding.EncodeToString(public))
		return nil
	}
	if manifestPath == "" || directory == "" || output == "" {
		return errors.New("Pass -manifest, -artifacts, and -out")
	}
	keyBytes, err := os.ReadFile(keyPath)
	if err != nil || len(keyBytes) > 8192 {
		return errors.New("Could not read the signing key")
	}
	block, _ := pem.Decode(keyBytes)
	if block == nil {
		return errors.New("Signing key must be Ed25519 PKCS8 PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return errors.New("Signing key is invalid")
	}
	private, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return errors.New("Signing key must be Ed25519")
	}
	bytes, err := os.ReadFile(manifestPath)
	if err != nil || len(bytes) > 128<<10 {
		return errors.New("Could not read bounded release metadata")
	}
	var manifest updates.Manifest
	if err := json.Unmarshal(bytes, &manifest); err != nil {
		return err
	}
	if manifest.Schema != 1 || manifest.Channel != "stable" || len(manifest.Artifacts) == 0 || len(manifest.Artifacts) > 8 {
		return errors.New("Invalid manifest schema, channel or artifacts")
	}
	if _, err := updates.CompareVersion(manifest.Version, "0.0.0"); err != nil {
		return err
	}
	for i := range manifest.Artifacts {
		artifact := &manifest.Artifacts[i]
		if filepath.Base(artifact.Filename) != artifact.Filename || artifact.Filename == "" {
			return errors.New("Artifact filename must be a basename")
		}
		path := filepath.Join(directory, artifact.Filename)
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > updates.MaxArtifactSize {
			file.Close()
			return errors.New("Invalid artifact file or size")
		}
		hash := sha256.New()
		count, err := io.Copy(hash, io.LimitReader(file, updates.MaxArtifactSize+1))
		file.Close()
		if err != nil || count != info.Size() {
			return errors.New("Could not hash the complete update")
		}
		digest := hash.Sum(nil)
		artifact.Size = count
		artifact.SHA256 = hex.EncodeToString(digest)
		artifact.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(private, digest))
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	envelope, err := json.MarshalIndent(updates.Envelope{Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(output, append(envelope, '\n'), 0644)
}
