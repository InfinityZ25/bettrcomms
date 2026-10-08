package api

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

var ErrAttachmentInfected = errors.New("attachment rejected by malware scanner")
var ErrScannerUnavailable = errors.New("attachment scanner unavailable")

type AttachmentScanner interface {
	Ping(context.Context) error
	Scan(context.Context, io.Reader, int64) error
}

type StorageFeatureOptions struct {
	Scanner      AttachmentScanner
	ScanMaxBytes int64
}

func StorageFeatureOptionsFromEnv() (*StorageFeatureOptions, error) {
	mode := strings.TrimSpace(os.Getenv("ATTACHMENT_SCAN_MODE"))
	if mode == "" || mode == "off" {
		return &StorageFeatureOptions{}, nil
	}
	if mode != "clamav" {
		return nil, errors.New("ATTACHMENT_SCAN_MODE must be off or clamav")
	}
	address := strings.TrimSpace(os.Getenv("CLAMAV_ADDRESS"))
	if address == "" {
		return nil, errors.New("CLAMAV_ADDRESS is required when scanning is enabled")
	}
	timeout := int64(120)
	maxBytes := DefaultAttachmentMaxBytes
	var err error
	if value := os.Getenv("CLAMAV_SCAN_TIMEOUT_SECONDS"); value != "" {
		timeout, err = strconv.ParseInt(value, 10, 64)
		if err != nil || timeout < 1 || timeout > 600 {
			return nil, errors.New("CLAMAV_SCAN_TIMEOUT_SECONDS must be between 1 and 600")
		}
	}
	if value := os.Getenv("CLAMAV_MAX_SCAN_BYTES"); value != "" {
		maxBytes, err = strconv.ParseInt(value, 10, 64)
		if err != nil || maxBytes < 1<<20 || maxBytes > MaximumAttachmentMaxBytes {
			return nil, errors.New("CLAMAV_MAX_SCAN_BYTES must be between 1048576 and 2147483648")
		}
	}
	return &StorageFeatureOptions{Scanner: &ClamAVScanner{Address: address, Timeout: time.Duration(timeout) * time.Second, MaxBytes: maxBytes}, ScanMaxBytes: maxBytes}, nil
}

// ClamAV uses its real streaming protocol; unknown/error responses never mean clean.
type ClamAVScanner struct {
	Address  string
	Timeout  time.Duration
	MaxBytes int64
}

func (s *ClamAVScanner) connect(ctx context.Context) (net.Conn, error) {
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	network, address := "tcp", s.Address
	if strings.HasPrefix(address, "unix://") {
		network, address = "unix", strings.TrimPrefix(address, "unix://")
	}
	conn, err := (&net.Dialer{Timeout: timeout}).DialContext(ctx, network, address)
	if err != nil {
		return nil, fmt.Errorf("%w: connection failed", ErrScannerUnavailable)
	}
	deadline := time.Now().Add(timeout)
	if caller, ok := ctx.Deadline(); ok && caller.Before(deadline) {
		deadline = caller
	}
	_ = conn.SetDeadline(deadline)
	return conn, nil
}
func clamReply(conn net.Conn) (string, error) {
	reader := bufio.NewReader(io.LimitReader(conn, 4097))
	value, err := reader.ReadString(0)
	if err != nil || len(value) > 4096 {
		return "", ErrScannerUnavailable
	}
	return strings.TrimSuffix(value, "\x00"), nil
}
func (s *ClamAVScanner) Ping(ctx context.Context) error {
	conn, err := s.connect(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if _, err = io.WriteString(conn, "zPING\x00"); err != nil {
		return ErrScannerUnavailable
	}
	reply, err := clamReply(conn)
	if err != nil || reply != "PONG" {
		return ErrScannerUnavailable
	}
	return nil
}
func (s *ClamAVScanner) Scan(ctx context.Context, body io.Reader, size int64) error {
	if s.MaxBytes > 0 && size > s.MaxBytes {
		return fmt.Errorf("%w: configured scan size limit", ErrScannerUnavailable)
	}
	conn, err := s.connect(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if _, err = io.WriteString(conn, "zINSTREAM\x00"); err != nil {
		return ErrScannerUnavailable
	}
	var prefix [4]byte
	buffer := make([]byte, 32<<10)
	var total int64
	for {
		if ctx.Err() != nil {
			return ErrScannerUnavailable
		}
		n, readErr := body.Read(buffer)
		if n > 0 {
			total += int64(n)
			if total > size {
				return ErrScannerUnavailable
			}
			binary.BigEndian.PutUint32(prefix[:], uint32(n))
			if err = writeClamFrame(conn, prefix[:]); err != nil {
				return ErrScannerUnavailable
			}
			if err = writeClamFrame(conn, buffer[:n]); err != nil {
				return ErrScannerUnavailable
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return ErrScannerUnavailable
		}
	}
	if total != size {
		return ErrScannerUnavailable
	}
	binary.BigEndian.PutUint32(prefix[:], 0)
	if err = writeClamFrame(conn, prefix[:]); err != nil {
		return ErrScannerUnavailable
	}
	reply, err := clamReply(conn)
	if err != nil {
		return err
	}
	if strings.HasSuffix(reply, ": OK") {
		return nil
	}
	if strings.HasSuffix(reply, " FOUND") {
		return ErrAttachmentInfected
	}
	return ErrScannerUnavailable
}
func writeClamFrame(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
func (a *API) scanner() AttachmentScanner {
	if a.StorageFeatures == nil {
		return nil
	}
	return a.StorageFeatures.Scanner
}
func (a *API) scannerConfig() map[string]any {
	scanner := a.scanner()
	status := "disabled"
	enabled := scanner != nil
	if enabled {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		status = "unavailable"
		if scanner.Ping(ctx) == nil {
			status = "ready"
		}
	}
	maxBytes := int64(0)
	if a.StorageFeatures != nil {
		maxBytes = a.StorageFeatures.ScanMaxBytes
	}
	return map[string]any{"enabled": enabled, "status": status, "max_scan_bytes": maxBytes}
}
