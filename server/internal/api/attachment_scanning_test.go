package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

func scannerServer(t *testing.T, command, reply string, expected []byte) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	done := make(chan error, 1)
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			done <- e
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		reader := bufio.NewReader(conn)
		got, e := reader.ReadString(0)
		if e != nil || got != command {
			done <- errors.New("incorrect clamd command")
			return
		}
		if command == "zINSTREAM\x00" {
			var body bytes.Buffer
			for {
				var size uint32
				if e = binary.Read(reader, binary.BigEndian, &size); e != nil {
					done <- e
					return
				}
				if size == 0 {
					break
				}
				if size > 32<<10 {
					done <- errors.New("unbounded clamd frame")
					return
				}
				if _, e = io.CopyN(&body, reader, int64(size)); e != nil {
					done <- e
					return
				}
			}
			if !bytes.Equal(body.Bytes(), expected) {
				done <- errors.New("scan bytes changed")
				return
			}
		}
		_, e = io.WriteString(conn, reply+"\x00")
		done <- e
	}()
	t.Cleanup(func() {
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(3 * time.Second):
			t.Error("clamd protocol handler did not finish")
		}
	})
	return listener.Addr().String()
}
func TestClamAVStreamingProtocol(t *testing.T) {
	body := bytes.Repeat([]byte("safe file bytes\n"), 10000)
	for _, test := range []struct {
		name, reply string
		want        error
	}{{"clean", "stream: OK", nil}, {"infected", "stream: Eicar-Signature FOUND", ErrAttachmentInfected}, {"size limit fails closed", "INSTREAM size limit exceeded. ERROR", ErrScannerUnavailable}, {"unknown fails closed", "not an approval", ErrScannerUnavailable}} {
		t.Run(test.name, func(t *testing.T) {
			scanner := ClamAVScanner{Address: scannerServer(t, "zINSTREAM\x00", test.reply, body), Timeout: time.Second, MaxBytes: 1 << 20}
			if err := scanner.Scan(context.Background(), bytes.NewReader(body), int64(len(body))); !errors.Is(err, test.want) {
				t.Fatalf("got %v want %v", err, test.want)
			}
		})
	}
	t.Run("ping", func(t *testing.T) {
		scanner := ClamAVScanner{Address: scannerServer(t, "zPING\x00", "PONG", nil), Timeout: time.Second}
		if err := scanner.Ping(context.Background()); err != nil {
			t.Fatal(err)
		}
	})
}
func TestClamAVUnavailableAndLimitsFailClosed(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	scanner := ClamAVScanner{Address: address, Timeout: time.Second, MaxBytes: 4}
	if err = scanner.Scan(context.Background(), strings.NewReader("12345"), 5); !errors.Is(err, ErrScannerUnavailable) {
		t.Fatal(err)
	}
	if err = scanner.Ping(context.Background()); !errors.Is(err, ErrScannerUnavailable) {
		t.Fatal(err)
	}
}
func TestClamAVCancellationClosesSocket(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan struct{})
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			return
		}
		defer conn.Close()
		_, _ = io.Copy(io.Discard, conn)
		close(done)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	scanner := ClamAVScanner{Address: listener.Addr().String(), Timeout: time.Minute}
	if err = scanner.Ping(ctx); !errors.Is(err, ErrScannerUnavailable) {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled scanner socket stayed open")
	}
}
func TestClamAVRealDaemonIntegration(t *testing.T) {
	address := os.Getenv("TEST_CLAMAV_ADDRESS")
	if address == "" {
		t.Skip("TEST_CLAMAV_ADDRESS not set")
	}
	scanner := ClamAVScanner{Address: address, Timeout: 10 * time.Second, MaxBytes: 1 << 20}
	if err := scanner.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	clean := "Bettercomms private attachment\n"
	if err := scanner.Scan(context.Background(), strings.NewReader(clean), int64(len(clean))); err != nil {
		t.Fatal(err)
	}
	// The industry standard harmless AV test signature is assembled in memory;
	// no infected file or executable is created in this checkout.
	signature := "X5O!P%@AP[4\\PZX54(P^)7CC)7}" + "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
	if err := scanner.Scan(context.Background(), strings.NewReader(signature), int64(len(signature))); !errors.Is(err, ErrAttachmentInfected) {
		t.Fatalf("EICAR was not rejected: %v", err)
	}
}
