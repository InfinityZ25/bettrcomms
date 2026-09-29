package main

import (
	"bettercomms/desktop-wails/internal/native/h264"
	"bettercomms/desktop-wails/internal/native/nativertc"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"sync"
	"time"
)

var metaSender struct {
	sync.Mutex
	hub *nativertc.Hub
}

// The page must present its native host capability before changing any sender.
func (a *AuthService) IOSMetaSender(token, command string, raw json.RawMessage) (any, error) {
	if err := a.authoriseNative(token); err != nil {
		return nil, err
	}
	var args struct {
		Event       string                `json:"event"`
		SessionID   string                `json:"sessionId"`
		PeerID      string                `json:"peerId"`
		IceServers  []nativertc.IceServer `json:"iceServers"`
		DirectOnly  bool                  `json:"directOnly"`
		Description struct {
			SDP string `json:"sdp"`
		} `json:"description"`
		Candidate *nativertc.IceCandidate `json:"candidate"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, errors.New("Invalid camera sender request")
	}
	if command == "native_camera_trace" {
		// Page traces carry signal types only; bound them before logging.
		if len(args.Event) > 80 {
			args.Event = args.Event[:80]
		}
		metaCameraLog("trace " + args.Event)
	} else if command != "native_screen_peer_connected" {
		metaCameraLog("command=" + command)
	}
	metaSender.Lock()
	h := metaSender.hub
	if command == "native_screen_start" {
		if h != nil {
			metaSender.Unlock()
			return nil, errors.New("Glasses sender is already active")
		}
		var err error
		h, err = nativertc.NewHub(uuid.NewString(), h264.Baseline, 720, 1280, 30, 3)
		if err != nil {
			metaSender.Unlock()
			return nil, err
		}
		if err = metaCameraSetPublishing(true); err != nil {
			h.Close()
			metaSender.Unlock()
			return nil, err
		}
		metaSender.hub = h
		go monitorMetaSender(h)
		metaSender.Unlock()
		return map[string]any{"sessionId": h.SessionID(), "fps": 30, "bitrateMbps": 3}, nil
	}
	metaSender.Unlock()
	if command == "native_camera_trace" {
		return nil, nil
	}
	if h == nil || h.SessionID() != args.SessionID {
		return nil, errors.New("Camera sender is no longer active")
	}
	switch command {
	case "native_screen_stop":
		stopMetaSender(h)
		return nil, nil
	case "native_screen_diagnostics":
		return h.Stats(), nil
	case "native_screen_peer_offer":
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		offer, err := h.CreatePeer(ctx, args.PeerID, args.IceServers, args.DirectOnly)
		metaCameraLog(fmt.Sprintf("offer complete success=%t", err == nil))
		return map[string]string{"type": "offer", "sdp": offer.SDP}, err
	case "native_screen_peer_answer":
		err := h.ApplyAnswer(args.PeerID, args.Description.SDP)
		metaCameraLog(fmt.Sprintf("answer applied success=%t", err == nil))
		return nil, err
	case "native_screen_peer_candidate":
		if args.Candidate == nil {
			return nil, nil
		}
		return nil, h.AddCandidate(args.PeerID, *args.Candidate)
	case "native_screen_peer_connected":
		return map[string]bool{"connected": h.PeerConnected(args.PeerID)}, nil
	case "native_screen_peer_remove":
		return nil, h.RemovePeer(args.PeerID)
	default:
		return nil, errors.New("Unknown camera sender command")
	}
}
func stopMetaSender(expected *nativertc.Hub) {
	metaSender.Lock()
	h := metaSender.hub
	if expected != nil && h != expected {
		metaSender.Unlock()
		return
	}
	metaSender.hub = nil
	_ = metaCameraSetPublishing(false)
	metaSender.Unlock()
	if h != nil {
		h.Close()
	}
}
func writeMetaVideo(data []byte) {
	metaSender.Lock()
	h := metaSender.hub
	metaSender.Unlock()
	if h != nil {
		_ = h.WriteAccessUnit(data, time.Now())
	}
}

func monitorMetaSender(h *nativertc.Hub) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		metaSender.Lock()
		current := metaSender.hub == h
		metaSender.Unlock()
		if !current {
			return
		}
		stats := h.Stats()
		metaCameraLog(fmt.Sprintf("sender frames=%d keyframes=%d bytes=%d peers=%d connected=%d dropped=%d", stats.AccessUnits, stats.Keyframes, stats.EncodedBytes, stats.Peers, stats.ConnectedPeers, stats.DroppedFrames))
	}
}
