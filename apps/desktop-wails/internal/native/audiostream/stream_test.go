package audiostream

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type effect struct {
	closed atomic.Int32
	calls  atomic.Int32
}

func (e *effect) Process(input []float32) ([]float32, error) {
	e.calls.Add(1)
	for i := range input {
		input[i] *= .5
	}
	return input, nil
}
func (e *effect) Close() { e.closed.Add(1) }

func start(t *testing.T) (*Stream, *effect) {
	t.Helper()
	e := &effect{}
	s, err := Start(func() (Processor, int, error) { return e, 2, nil }, func(origin string) bool { return origin == "http://wails.localhost" })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		s.Stop()
		select {
		case <-s.Done():
		case <-time.After(time.Second):
			t.Error("effect not released")
		}
	})
	return s, e
}

func dial(t *testing.T, s *Stream, origin string) (*websocket.Conn, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/", s.Grant.Port), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
	if c != nil {
		t.Cleanup(func() { _ = c.CloseNow() })
	}
	return c, err
}

func authenticate(t *testing.T, c *websocket.Conn, token string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"token":%q}`, token))); err != nil {
		t.Fatal(err)
	}
	kind, body, err := c.Read(ctx)
	if err != nil || kind != websocket.MessageText || !bytesContainsReady(body) {
		t.Fatalf("handshake failed: %v", err)
	}
}
func bytesContainsReady(body []byte) bool {
	return string(body) == `{"frameSamples":2,"sampleRate":48000,"type":"ready"}`
}

func TestBinaryRoundTripAndCleanup(t *testing.T) {
	s, e := start(t)
	c, err := dial(t, s, "http://wails.localhost")
	if err != nil {
		t.Fatal(err)
	}
	authenticate(t, c, s.Grant.Token)
	body := make([]byte, 8)
	binary.LittleEndian.PutUint32(body, math.Float32bits(.75))
	binary.LittleEndian.PutUint32(body[4:], math.Float32bits(-.5))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageBinary, body); err != nil {
		t.Fatal(err)
	}
	kind, output, err := c.Read(ctx)
	if err != nil || kind != websocket.MessageBinary {
		t.Fatalf("frame failed: %v", err)
	}
	samples, err := decode(output, 2)
	if err != nil || samples[0] != .375 || samples[1] != -.25 {
		t.Fatal("PCM bytes changed")
	}
	s.Stop()
	<-s.Done()
	s.Stop()
	if e.closed.Load() != 1 || e.calls.Load() != 1 {
		t.Fatal("incorrect effect lifecycle")
	}
}

func TestOriginAndSingleClient(t *testing.T) {
	s, _ := start(t)
	for _, origin := range []string{"", "https://evil.example", "http://wails.localhost.evil.example"} {
		if _, err := dial(t, s, origin); err == nil {
			t.Fatalf("accepted origin %q", origin)
		}
	}
	c, err := dial(t, s, "http://wails.localhost")
	if err != nil {
		t.Fatal(err)
	}
	authenticate(t, c, s.Grant.Token)
	if _, err := dial(t, s, "http://wails.localhost"); err == nil {
		t.Fatal("accepted second client")
	}
}

func TestBadAuthReleasesEffect(t *testing.T) {
	s, e := start(t)
	c, err := dial(t, s, "http://wails.localhost")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"token":"wrong"}`))
	if _, _, err := c.Read(ctx); err == nil {
		t.Fatal("wrong token accepted")
	}
	select {
	case <-s.Done():
	case <-ctx.Done():
		t.Fatal("effect leaked")
	}
	if e.closed.Load() != 1 || e.calls.Load() != 0 {
		t.Fatal("unauthorised processing")
	}
}

func TestInvalidFramesNeverReachEffect(t *testing.T) {
	for _, body := range [][]byte{make([]byte, 7), {0, 0, 128, 127, 0, 0, 0, 0}, make([]byte, 5000)} {
		t.Run(fmt.Sprint(len(body)), func(t *testing.T) {
			s, e := start(t)
			c, err := dial(t, s, "http://wails.localhost")
			if err != nil {
				t.Fatal(err)
			}
			authenticate(t, c, s.Grant.Token)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = c.Write(ctx, websocket.MessageBinary, body)
			if _, _, err := c.Read(ctx); err == nil {
				t.Fatal("invalid frame accepted")
			}
			if e.calls.Load() != 0 {
				t.Fatal("invalid PCM reached effect")
			}
		})
	}
}

func TestStrictToken(t *testing.T) {
	if !validToken([]byte(`{"token":"secret"}`), "secret") {
		t.Fatal("valid token rejected")
	}
	for _, input := range []string{`{"token":"other"}`, `{"token":"secret","extra":1}`, `{"token":"secret"}{}`, `null`} {
		if validToken([]byte(input), "secret") {
			t.Fatal("invalid auth accepted")
		}
	}
}

func TestFactoryFailureAndIndependentSessions(t *testing.T) {
	if _, err := Start(func() (Processor, int, error) { return nil, 0, errors.New("GPU unavailable") }, func(string) bool { return false }); err == nil {
		t.Fatal("startup failure ignored")
	}
	a, ea := start(t)
	b, eb := start(t)
	if a.Grant.Token == b.Grant.Token || a.Grant.Port == b.Grant.Port || a.Grant.SessionID == b.Grant.SessionID {
		t.Fatal("sessions share credentials")
	}
	a.Stop()
	<-a.Done()
	if ea.closed.Load() != 1 || eb.closed.Load() != 0 {
		t.Fatal("stopping one session affected another")
	}
}

func TestUnusedAndIdleGrantsExpire(t *testing.T) {
	for _, connect := range []bool{false, true} {
		t.Run(fmt.Sprint(connect), func(t *testing.T) {
			t.Parallel()
			s, e := start(t)
			if connect {
				c, err := dial(t, s, "http://wails.localhost")
				if err != nil {
					t.Fatal(err)
				}
				authenticate(t, c, s.Grant.Token)
			}
			select {
			case <-s.Done():
			case <-time.After(7 * time.Second):
				t.Fatal("unused audio effect leaked")
			}
			if e.closed.Load() != 1 {
				t.Fatal("effect was not closed exactly once")
			}
		})
	}
}
