package broadcastipc

import (
	"crypto/subtle"
	"errors"
	"io"
	"net"
	"time"
)

// KeySize is the length of each single-use handoff key.
const KeySize = 32

var ErrHandshake = errors.New("broadcast handshake failed")

// The host and the extension each prove they read the handoff file from the
// shared App Group container. The extension speaks first; the host answers
// with its own key. Checking only the extension's key would let any app that
// binds the loopback port after BetterComms exits receive the whole screen.

// AcceptExtension verifies the extension's key and then proves the host.
func AcceptExtension(conn net.Conn, extensionKey, hostKey []byte, timeout time.Duration) error {
	return handshake(conn, timeout, func() error {
		if err := expect(conn, extensionKey); err != nil {
			return err
		}
		_, err := conn.Write(hostKey)
		return err
	})
}

// DialHost proves the extension and then verifies the host's key.
func DialHost(conn net.Conn, extensionKey, hostKey []byte, timeout time.Duration) error {
	return handshake(conn, timeout, func() error {
		if _, err := conn.Write(extensionKey); err != nil {
			return err
		}
		return expect(conn, hostKey)
	})
}

func handshake(conn net.Conn, timeout time.Duration, steps func() error) error {
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := steps(); err != nil {
		return ErrHandshake
	}
	return conn.SetDeadline(time.Time{})
}

func expect(r io.Reader, key []byte) error {
	if len(key) != KeySize {
		return ErrHandshake
	}
	got := make([]byte, KeySize)
	if _, err := io.ReadFull(r, got); err != nil || subtle.ConstantTimeCompare(got, key) != 1 {
		return ErrHandshake
	}
	return nil
}
