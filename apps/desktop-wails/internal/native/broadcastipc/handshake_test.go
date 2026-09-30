package broadcastipc

import (
	"bytes"
	"net"
	"testing"
	"time"
)

func keys() ([]byte, []byte) {
	return bytes.Repeat([]byte{1}, KeySize), bytes.Repeat([]byte{2}, KeySize)
}

func TestHandshakeAuthenticatesBothSides(t *testing.T) {
	extensionKey, hostKey := keys()
	host, extension := net.Pipe()
	defer host.Close()
	defer extension.Close()
	result := make(chan error, 1)
	go func() { result <- AcceptExtension(host, extensionKey, hostKey, time.Second) }()
	if err := DialHost(extension, extensionKey, hostKey, time.Second); err != nil {
		t.Fatalf("extension rejected the real host: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("host rejected the real extension: %v", err)
	}
}

func TestExtensionRefusesImpostorHost(t *testing.T) {
	extensionKey, hostKey := keys()
	impostor, extension := net.Pipe()
	defer impostor.Close()
	defer extension.Close()
	// An app bound to the freed port reads the extension's key and has to
	// guess the host's.
	go func() {
		buffer := make([]byte, KeySize)
		_, _ = impostor.Read(buffer)
		_, _ = impostor.Write(bytes.Repeat([]byte{9}, KeySize))
	}()
	if err := DialHost(extension, extensionKey, hostKey, time.Second); err != ErrHandshake {
		t.Fatalf("extension accepted an impostor host: %v", err)
	}
}

func TestHostRefusesWrongKeyWithoutRevealingItsOwn(t *testing.T) {
	extensionKey, hostKey := keys()
	host, stranger := net.Pipe()
	defer host.Close()
	defer stranger.Close()
	result := make(chan error, 1)
	go func() { result <- AcceptExtension(host, extensionKey, hostKey, time.Second) }()
	_, _ = stranger.Write(bytes.Repeat([]byte{7}, KeySize))
	if err := <-result; err != ErrHandshake {
		t.Fatalf("host accepted a wrong key: %v", err)
	}
	_ = stranger.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	if n, _ := stranger.Read(make([]byte, KeySize)); n != 0 {
		t.Fatal("host revealed its key to an unverified connection")
	}
}

func TestIdleConnectionTimesOut(t *testing.T) {
	extensionKey, hostKey := keys()
	host, idle := net.Pipe()
	defer host.Close()
	defer idle.Close()
	start := time.Now()
	if err := AcceptExtension(host, extensionKey, hostKey, 50*time.Millisecond); err != ErrHandshake {
		t.Fatalf("idle connection was not rejected: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("handshake ignored its deadline")
	}
}
