// Package audiostream connects a dedicated audio Worker to one native DSP
// instance. It implements the existing Tauri worker protocol, not JSON audio IPC.
package audiostream

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type Processor interface {
	Process([]float32) ([]float32, error)
	Close()
}

// Factory creates a fresh effect, on the same OS thread that will process and
// destroy it. The factory must release partially constructed effects on error.
type Factory func() (Processor, int, error)

type Grant struct {
	SessionID    string `json:"sessionId"`
	FrameSamples int    `json:"frameSamples"`
	SampleRate   int    `json:"sampleRate"`
	Port         int    `json:"port"`
	Token        string `json:"token"`
}

type frame struct {
	input  []float32
	result chan result
}
type result struct {
	output []float32
	err    error
}

type Stream struct {
	Grant    Grant
	cancel   context.CancelFunc
	done     chan struct{}
	server   *http.Server
	listener net.Listener
	once     sync.Once
	claimed  atomic.Bool
	frames   chan frame
}

const handshakeTimeout = 5 * time.Second
const idleTimeout = 5 * time.Second

// Start binds loopback only. allowedOrigin must enforce the host's exact
// document-origin policy; a valid Origin alone never substitutes for the token.
// The caller must impose a session-count limit before constructing GPU effects.
func Start(factory Factory, allowedOrigin func(string) bool) (*Stream, error) {
	if factory == nil || allowedOrigin == nil {
		return nil, errors.New("audio stream requires an effect and origin policy")
	}
	secret := make([]byte, 48)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Stream{cancel: cancel, done: make(chan struct{}), listener: listener, frames: make(chan frame)}
	s.Grant = Grant{SessionID: hex.EncodeToString(secret[:16]), Token: hex.EncodeToString(secret[16:]), SampleRate: 48000, Port: listener.Addr().(*net.TCPAddr).Port}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(s.done)
		processor, samples, err := factory()
		if err != nil {
			ready <- err
			return
		}
		if processor == nil {
			ready <- errors.New("audio factory returned no effect")
			return
		}
		defer processor.Close()
		if samples < 1 || samples > 960 {
			ready <- errors.New("invalid native audio frame size")
			return
		}
		s.Grant.FrameSamples = samples
		ready <- nil
		for {
			select {
			case <-ctx.Done():
				return
			case request := <-s.frames:
				output, err := processor.Process(request.input)
				request.result <- result{output, err}
			}
		}
	}()
	if err := <-ready; err != nil {
		cancel()
		_ = listener.Close()
		<-s.done
		return nil, err
	}
	s.server = &http.Server{ReadHeaderTimeout: handshakeTimeout, MaxHeaderBytes: 4096}
	s.server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/" || r.URL.RawQuery != "" || !allowedOrigin(r.Header.Get("Origin")) {
			http.Error(w, "audio origin denied", http.StatusForbidden)
			return
		}
		// Only one handshake can occupy this session. Failed authentication
		// destroys the grant, rather than permitting retries or queued clients.
		if !s.claimed.CompareAndSwap(false, true) {
			http.Error(w, "audio session already claimed", http.StatusConflict)
			return
		}
		defer s.Stop()
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true}) // exact origin checked above
		if err != nil {
			return
		}
		defer conn.CloseNow()
		conn.SetReadLimit(4096)
		authCtx, authCancel := context.WithTimeout(ctx, handshakeTimeout)
		kind, body, err := conn.Read(authCtx)
		authCancel()
		if err != nil || kind != websocket.MessageText || !validToken(body, s.Grant.Token) {
			return
		}
		body, _ = json.Marshal(map[string]any{"type": "ready", "frameSamples": s.Grant.FrameSamples, "sampleRate": 48000})
		if write(ctx, conn, websocket.MessageText, body) != nil {
			return
		}
		for {
			readCtx, readCancel := context.WithTimeout(ctx, idleTimeout)
			kind, body, err := conn.Read(readCtx)
			readCancel()
			if err != nil || kind != websocket.MessageBinary {
				return
			}
			input, err := decode(body, s.Grant.FrameSamples)
			if err != nil {
				return
			}
			request := frame{input: input, result: make(chan result, 1)}
			select {
			case s.frames <- request:
			case <-ctx.Done():
				return
			}
			var processed result
			select {
			case processed = <-request.result:
			case <-ctx.Done():
				return
			}
			if processed.err != nil || len(processed.output) != s.Grant.FrameSamples {
				return
			}
			encoded := make([]byte, len(processed.output)*4)
			for i, sample := range processed.output {
				if math.IsNaN(float64(sample)) || math.IsInf(float64(sample), 0) {
					return
				}
				binary.LittleEndian.PutUint32(encoded[i*4:], math.Float32bits(sample))
			}
			if write(ctx, conn, websocket.MessageBinary, encoded) != nil {
				return
			}
		}
	})
	go func() { _ = s.server.Serve(listener); cancel() }()
	// A grant that is never used must not retain a GPU context indefinitely.
	go func() {
		timer := time.NewTimer(handshakeTimeout)
		defer timer.Stop()
		select {
		case <-timer.C:
			if !s.claimed.Load() {
				s.Stop()
			}
		case <-ctx.Done():
		}
	}()
	return s, nil
}

// Stop closes network IO immediately. Done closes after the effect has been
// released on its owning thread; GPU calls already in progress cannot be killed.
func (s *Stream) Stop() {
	s.once.Do(func() { s.cancel(); _ = s.server.Close(); _ = s.listener.Close() })
}
func (s *Stream) Done() <-chan struct{} { return s.done }

func write(ctx context.Context, conn *websocket.Conn, kind websocket.MessageType, body []byte) error {
	bounded, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	return conn.Write(bounded, kind, body)
}

func validToken(body []byte, expected string) bool {
	var auth struct {
		Token string `json:"token"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&auth) != nil || decoder.Decode(new(any)) != io.EOF {
		return false
	}
	return expected != "" && subtle.ConstantTimeCompare([]byte(auth.Token), []byte(expected)) == 1
}

func decode(body []byte, samples int) ([]float32, error) {
	if len(body) != samples*4 {
		return nil, errors.New("invalid audio frame length")
	}
	input := make([]float32, samples)
	for i := range input {
		input[i] = math.Float32frombits(binary.LittleEndian.Uint32(body[i*4:]))
		if math.IsNaN(float64(input[i])) || math.IsInf(float64(input[i]), 0) {
			return nil, errors.New("non-finite audio sample")
		}
	}
	return input, nil
}
