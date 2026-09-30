package nativertc

import (
	"bettercomms/desktop-wails/internal/native/h264"
	"context"
	"github.com/pion/webrtc/v4"
	"strings"
	"testing"
	"time"
)

func TestBroadcastAudioIsSeparateAndExcludedFromPreview(t *testing.T) {
	h, err := NewHub("broadcast", h264.Baseline, 1920, 1080, 30, 12, WithBroadcastAudio(), WithMaxQueueAge(150*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	offer, err := h.CreatePeer(context.Background(), "viewer", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(offer.SDP, "m=audio") || !strings.Contains(offer.SDP, "opus/48000/2") || !strings.Contains(offer.SDP, "native-screen-audio-broadcast") {
		t.Fatal("no independent Opus audio track in offer")
	}
	preview, err := h.CreatePeer(context.Background(), PreviewPeerID, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(preview.SDP, "m=audio") {
		t.Fatal("preview audio would echo app audio")
	}
	legacy, err := h.CreatePeerWithAudio(context.Background(), "legacy", nil, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(legacy.SDP, "m=audio") {
		t.Fatal("legacy viewer received unsupported audio")
	}
	viewer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.Close()
	received := make(chan *webrtc.TrackRemote, 1)
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() == webrtc.RTPCodecTypeAudio {
			received <- track
		}
	})
	if err = viewer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := viewer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather := webrtc.GatheringCompletePromise(viewer)
	if err = viewer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gather
	if err = h.ApplyAnswer("viewer", viewer.LocalDescription().SDP); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		pts := time.Second
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = h.WriteOpus([]byte{0xf8, 0xff, 0xfe}, pts)
				pts += 20 * time.Millisecond
			}
		}
	}()
	select {
	case track := <-received:
		_ = track.SetReadDeadline(time.Now().Add(5 * time.Second))
		packet, _, err := track.ReadRTP()
		if err != nil || len(packet.Payload) == 0 {
			t.Fatalf("no audio RTP: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("viewer received no app audio")
	}
	if h.Stats().AudioPackets == 0 {
		t.Fatal("audio diagnostics not counted")
	}
	if err = h.RemovePeer("viewer"); err != nil {
		t.Fatal(err)
	}
}
func TestCaptureTimestampsKeepGapsAndWrap(t *testing.T) {
	h := newTestHub(t)
	first := h.captureTimestampLocked(100*time.Second, RTPClockRate)
	next := h.captureTimestampLocked(100*time.Second+100*time.Millisecond, RTPClockRate)
	if next-first != 9000 {
		t.Fatalf("100ms gap was compressed to nominal FPS: %d", next-first)
	}
	audio := h.captureTimestampLocked(100*time.Second+100*time.Millisecond, 48000)
	if audio != 4800 {
		t.Fatalf("audio and video did not share the capture origin: %d", audio)
	}
}
func TestBroadcastAudioQueueIsBoundedAndClosedHubRejectsPackets(t *testing.T) {
	h := newTestHub(t)
	h.audioEnabled = true
	p := &peer{audio: make(chan *encodedAudio, 5), audioActive: true}
	h.peers["slow"] = p
	for i := range 30 {
		if err := h.WriteOpus([]byte{0xf8, 0xff, 0xfe}, time.Duration(i)*20*time.Millisecond); err != nil {
			t.Fatal(err)
		}
	}
	if len(p.audio) != 5 || h.audioDropped.Load() != 25 {
		t.Fatal("audio backlog is unbounded")
	}
	if frame := <-p.audio; frame.stamp != 25*960 {
		t.Fatalf("stale audio retained: %d", frame.stamp)
	}
	delete(h.peers, "slow")
	h.Close()
	if h.WriteOpus([]byte{0xf8, 0xff, 0xfe}, time.Second) == nil {
		t.Fatal("closed hub accepted audio")
	}
}
