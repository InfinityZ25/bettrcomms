//go:build ios

package main

/*
#include <stdlib.h>
void bc_broadcast_ended(void);
*/
import "C"

import (
	"bettercomms/desktop-wails/internal/native/broadcastipc"
	"bettercomms/desktop-wails/internal/native/h264"
	"bettercomms/desktop-wails/internal/native/nativertc"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"runtime/debug"
	"sync"
	"time"
	"unsafe"
)

var state struct {
	sync.Mutex
	hub     *nativertc.Hub
	cancel  context.CancelFunc
	conn    net.Conn
	session string
}

func main() {}

//export bc_broadcast_connect
func bc_broadcast_connect(path *C.char) {
	configPath := C.GoString(path)
	ctx, cancel := context.WithCancel(context.Background())
	state.Lock()
	state.cancel = cancel
	state.Unlock()
	go func() {
		defer cancel()
		// ReplayKit extensions have a small memory allowance. Keep Go's heap
		// conservative; VideoToolbox allocations live outside that heap.
		debug.SetMemoryLimit(16 * 1024 * 1024)
		debug.SetGCPercent(30)
		data, err := os.ReadFile(configPath)
		var cfg struct {
			Port    int    `json:"port"`
			Token   string `json:"token"`
			Session string `json:"session"`
			Expires int64  `json:"expires"`
		}
		if err != nil || len(data) > 4096 || json.Unmarshal(data, &cfg) != nil || cfg.Expires < time.Now().Unix() || cfg.Port < 1 || cfg.Port > 65535 {
			C.bc_broadcast_ended()
			return
		}
		token, err := hex.DecodeString(cfg.Token)
		if err != nil || len(token) != 32 || cfg.Session == "" {
			C.bc_broadcast_ended()
			return
		}
		conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp4", net.JoinHostPort("127.0.0.1", fmtPort(cfg.Port)))
		if err != nil {
			C.bc_broadcast_ended()
			return
		}
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err = conn.Write(token); err != nil {
			conn.Close()
			C.bc_broadcast_ended()
			return
		}
		_ = conn.SetWriteDeadline(time.Time{})
		state.Lock()
		if ctx.Err() != nil {
			state.Unlock()
			conn.Close()
			return
		}
		state.conn = conn
		state.cancel = cancel
		state.session = cfg.Session
		state.Unlock()
		_ = broadcastipc.Serve(ctx, conn, command)
		bc_broadcast_stop()
		C.bc_broadcast_ended()
	}()
}

func fmtPort(port int) string { b, _ := json.Marshal(port); return string(b) }

func command(ctx context.Context, name string, raw json.RawMessage) (any, error) {
	var a struct {
		SessionID   string                `json:"sessionId"`
		PeerID      string                `json:"peerId"`
		IceServers  []nativertc.IceServer `json:"iceServers"`
		DirectOnly  bool                  `json:"directOnly"`
		Description struct {
			SDP string `json:"sdp"`
		} `json:"description"`
		Candidate *nativertc.IceCandidate `json:"candidate"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, errors.New("Invalid screen command")
	}
	state.Lock()
	if err := ctx.Err(); err != nil {
		state.Unlock()
		return nil, err
	}
	h := state.hub
	id := state.session
	if name == "native_screen_start" {
		if h != nil {
			state.Unlock()
			return nil, errors.New("Screen broadcast already started")
		}
		var err error
		h, err = nativertc.NewHub(id, h264.Baseline, 720, 1280, 30, 8, nativertc.WithAdaptiveBitrate(1_000_000, 3_000_000, 6_000_000))
		state.hub = h
		state.Unlock()
		return map[string]any{"sessionId": id, "fps": 30, "bitrateMbps": 3}, err
	}
	state.Unlock()
	if h == nil || a.SessionID != id {
		return nil, errors.New("Screen broadcast is no longer active")
	}
	switch name {
	case "native_screen_peer_offer":
		offer, err := h.CreatePeer(ctx, a.PeerID, a.IceServers, a.DirectOnly)
		return map[string]string{"type": "offer", "sdp": offer.SDP}, err
	case "native_screen_peer_answer":
		return nil, h.ApplyAnswer(a.PeerID, a.Description.SDP)
	case "native_screen_peer_candidate":
		if a.Candidate != nil {
			return nil, h.AddCandidate(a.PeerID, *a.Candidate)
		}
		return nil, nil
	case "native_screen_peer_remove":
		return nil, h.RemovePeer(a.PeerID)
	case "native_screen_peer_connected":
		return map[string]bool{"connected": h.PeerConnected(a.PeerID)}, nil
	case "native_screen_diagnostics":
		return h.Stats(), nil
	default:
		return nil, errors.New("Unknown screen broadcast command")
	}
}

//export bc_broadcast_stop
func bc_broadcast_stop() {
	state.Lock()
	h, cancel, conn := state.hub, state.cancel, state.conn
	state.hub = nil
	state.cancel = nil
	state.conn = nil
	if cancel != nil {
		cancel()
	}
	state.Unlock()
	if conn != nil {
		conn.Close()
	}
	if h != nil {
		h.Close()
	}
}

//export bc_broadcast_video
func bc_broadcast_video(data unsafe.Pointer, size C.int) {
	if size <= 0 || size > 2*1024*1024 {
		return
	}
	state.Lock()
	h := state.hub
	state.Unlock()
	if h != nil {
		_ = h.WriteAccessUnit(C.GoBytes(data, size), time.Now())
	}
}

//export bc_broadcast_encoder_control
func bc_broadcast_encoder_control(force *C.int) C.int {
	state.Lock()
	h := state.hub
	state.Unlock()
	*force = 0
	if h == nil {
		return 0
	}
	c := h.NextEncoderControl(time.Now())
	if c.ForceKeyframe {
		*force = 1
	}
	return C.int(c.Bitrate)
}
