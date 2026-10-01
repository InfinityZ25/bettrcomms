//go:build android

package main

import (
	"bettercomms/desktop-wails/internal/native/h264"
	"bettercomms/desktop-wails/internal/native/nativertc"
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"sync"
	"time"
)

var androidAudio struct {
	sync.Mutex
	generation uint64
}

func androidCallAudio(active bool) error {
	androidAudio.Lock()
	defer androidAudio.Unlock()
	androidAudio.generation++
	if active {
		return androidCommand("audio:start")
	}
	return androidCommand("audio:stop")
}

var androidSignaling struct {
	sync.Mutex
	open  func() bool
	opens func() uint64
	timer *time.Timer
}

func androidWatchSignaling(open func() bool, opens func() uint64) {
	androidSignaling.Lock()
	androidSignaling.open, androidSignaling.opens = open, opens
	androidSignaling.Unlock()
}

// The page may be suspended when the call socket closes. Bound native capture
// and audio focus without a JS heartbeat; transient reconnections get a grace.
func androidSignalingClosed() {
	androidSignaling.Lock()
	defer androidSignaling.Unlock()
	if androidSignaling.open == nil {
		return
	}
	if androidSignaling.timer != nil {
		androidSignaling.timer.Stop()
	}
	open, opens := androidSignaling.open, androidSignaling.opens
	epoch := opens()
	androidScreen.Lock()
	screen := androidScreen.hub
	androidScreen.Unlock()
	metaSender.Lock()
	meta := metaSender.hub
	metaSender.Unlock()
	androidAudio.Lock()
	audio := androidAudio.generation
	androidAudio.Unlock()
	androidSignaling.timer = time.AfterFunc(30*time.Second, func() {
		if open() || opens() != epoch {
			return
		}
		if screen != nil {
			stopAndroidScreen(screen.SessionID())
		}
		if meta != nil {
			metaSender.Lock()
			current := metaSender.hub == meta
			if current {
				metaSender.hub = nil
				_ = androidCommand("meta:preview")
				_ = androidCommand("meta:stop")
			}
			metaSender.Unlock()
			if current {
				meta.Close()
			}
		}
		androidAudio.Lock()
		if androidAudio.generation == audio {
			androidAudio.generation++
			_ = androidCommand("audio:stop")
		}
		androidAudio.Unlock()
	})
}

var androidScreen struct {
	sync.Mutex
	hub   *nativertc.Hub
	owner string
}

func androidScreenCommand(ctx context.Context, command string, raw json.RawMessage) (any, error) {
	var args struct {
		Owner       string                `json:"owner"`
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
		return nil, errors.New("invalid Android screen request")
	}
	androidScreen.Lock()
	h := androidScreen.hub
	owner := androidScreen.owner
	if command == "native_screen_start" {
		if h != nil {
			androidScreen.Unlock()
			return nil, errors.New("screen sharing is already active")
		}
		if args.Owner == "" {
			androidScreen.Unlock()
			return nil, errors.New("screen owner is required")
		}
		var err error
		h, err = nativertc.NewHub(uuid.NewString(), h264.Baseline, 720, 1280, 30, 8, nativertc.WithAdaptiveBitrate(1_000_000, 3_000_000, 8_000_000))
		if err != nil {
			androidScreen.Unlock()
			return nil, err
		}
		androidScreen.hub, androidScreen.owner = h, args.Owner
		androidScreen.Unlock()
		if err := androidCommand("screen:start:" + h.SessionID()); err != nil {
			stopAndroidScreen(h.SessionID())
			return nil, err
		}
		// Do not announce a share or negotiate receivers while Android is
		// still asking for consent. Otherwise slow consent looks like a lost
		// video feed and triggers receiver fallback before capture even starts.
		if err := awaitAndroidScreen(ctx, h); err != nil {
			stopAndroidScreen(h.SessionID())
			return nil, err
		}
		return map[string]any{"sessionId": h.SessionID(), "fps": 30, "bitrateMbps": 3}, nil
	}
	androidScreen.Unlock()
	switch command {
	case "native_screen_active":
		id := ""
		if h != nil {
			id = h.SessionID()
		}
		return map[string]string{"sessionId": id}, nil
	case "native_screen_release_orphans":
		if h != nil && owner != args.Owner {
			stopAndroidScreen(h.SessionID())
		}
		return nil, nil
	case "native_screen_cancel_pending":
		// Capture consent is owned by Android. Cancel our generation, so a
		// late picker result cannot start capturing after leaving the call.
		releaseAndroidScreen("", true)
		return nil, nil
	}
	if h == nil || h.SessionID() != args.SessionID {
		return nil, errors.New("screen share is no longer active")
	}
	switch command {
	case "native_screen_stop":
		stopAndroidScreen(args.SessionID)
		return nil, nil
	case "native_screen_ice_servers":
		return nil, h.UpdateIceServers(args.IceServers)
	case "native_screen_diagnostics":
		return h.Stats(), nil
	case "native_screen_peer_offer":
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		offer, err := h.CreatePeer(ctx, args.PeerID, args.IceServers, args.DirectOnly)
		return map[string]string{"type": "offer", "sdp": offer.SDP}, err
	case "native_screen_peer_answer":
		return nil, h.ApplyAnswer(args.PeerID, args.Description.SDP)
	case "native_screen_peer_candidate":
		if args.Candidate == nil {
			return nil, nil
		}
		return nil, h.AddCandidate(args.PeerID, *args.Candidate)
	case "native_screen_peer_remove":
		return nil, h.RemovePeer(args.PeerID)
	default:
		return nil, errors.New("unknown Android screen command")
	}
}

func awaitAndroidScreen(ctx context.Context, expected *nativertc.Hub) error {
	deadline := time.NewTimer(2 * time.Minute)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		androidScreen.Lock()
		live := androidScreen.hub == expected
		androidScreen.Unlock()
		if !live {
			return errors.New("screen sharing was cancelled or stopped")
		}
		if expected.Stats().AccessUnits > 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("screen-sharing consent timed out; close the Android prompt and try again")
		case <-tick.C:
		}
	}
}
func stopAndroidScreen(expected string) { releaseAndroidScreen(expected, false) }

func releaseAndroidScreen(expected string, pendingOnly bool) {
	androidScreen.Lock()
	h := androidScreen.hub
	if h == nil || (expected != "" && h.SessionID() != expected) || (pendingOnly && h.Stats().AccessUnits > 0) {
		androidScreen.Unlock()
		return
	}
	androidScreen.hub, androidScreen.owner = nil, ""
	androidScreen.Unlock()
	_ = androidCommand("screen:stop:" + h.SessionID())
	// JNI stop callbacks run on Android's main looper. Detach immediately,
	// then tear down peer sockets off that thread using the captured hub.
	go h.Close()
}
func writeAndroidScreen(session string, data []byte, captured time.Duration) {
	androidScreen.Lock()
	h := androidScreen.hub
	androidScreen.Unlock()
	if h != nil && h.SessionID() == session {
		_ = h.WriteTimedAccessUnit(data, time.Now(), captured)
	}
}
func androidScreenEncoderControl() nativertc.EncoderControl {
	androidScreen.Lock()
	h := androidScreen.hub
	androidScreen.Unlock()
	if h == nil {
		return nativertc.EncoderControl{}
	}
	return h.NextEncoderControl(time.Now())
}
