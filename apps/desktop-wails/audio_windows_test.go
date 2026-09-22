//go:build windows

package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"net/http"
	"testing"
	"time"

	"bettercomms/desktop-wails/internal/desktop"
	"bettercomms/desktop-wails/internal/native/audiostream"
	"bettercomms/desktop-wails/internal/native/deepfilter"
	"github.com/coder/websocket"
)

// This exercises the actual GPU behind the same grant and binary protocol the
// frontend Worker uses. It does not establish audible quality or WebView timing.
func TestDeepfilterStreamOnInstalledGPU(t *testing.T) {
	probe := deepfilter.NewEngine()
	status := probe.Status()
	probe.Close()
	if !status.Available {
		t.Skipf("DirectML unavailable: %s", status.Detail)
	}
	gate, err := desktop.NewPageGate()
	if err != nil {
		t.Fatal(err)
	}
	s := &NativeMediaService{gate: gate, streams: audiostream.NewManager()}
	defer s.streams.Close()
	grant, err := s.AudioStreamStart(gate.Token(), "deepfilter", 1, false, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer s.AudioStreamStop(gate.Token(), grant.SessionID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/", grant.Port), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://wails.localhost"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"token":%q}`, grant.Token))); err != nil {
		t.Fatal(err)
	}
	if kind, _, err := conn.Read(ctx); err != nil || kind != websocket.MessageText {
		t.Fatalf("handshake: %v", err)
	}
	changed := false
	for frame := 0; frame < 30; frame++ {
		body := make([]byte, grant.FrameSamples*4)
		for i := 0; i < grant.FrameSamples; i++ {
			sample := float32(math.Sin(float64(frame*grant.FrameSamples+i)*.071) * .05)
			binary.LittleEndian.PutUint32(body[i*4:], math.Float32bits(sample))
		}
		if err := conn.Write(ctx, websocket.MessageBinary, body); err != nil {
			t.Fatal(err)
		}
		kind, output, err := conn.Read(ctx)
		if err != nil || kind != websocket.MessageBinary || len(output) != len(body) {
			t.Fatalf("frame %d failed: %v", frame, err)
		}
		for i := 0; i < grant.FrameSamples; i++ {
			bits := binary.LittleEndian.Uint32(output[i*4:])
			value := float64(math.Float32frombits(bits))
			if math.IsNaN(value) || math.IsInf(value, 0) {
				t.Fatal("non-finite GPU output")
			}
			changed = changed || bits != binary.LittleEndian.Uint32(body[i*4:])
		}
	}
	if !changed {
		t.Fatal("GPU transport returned only unchanged input")
	}
	t.Logf("30 binary frames processed through %s", status.Adapter)
}
