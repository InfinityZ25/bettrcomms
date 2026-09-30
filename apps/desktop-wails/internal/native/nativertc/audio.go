package nativertc

import (
	"context"
	"errors"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"time"
)

var broadcastAudioCodec = webrtc.RTPCodecCapability{
	MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
	SDPFmtpLine: "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1",
}

type encodedAudio struct {
	data    []byte
	stamp   uint32
	arrived time.Time
}

// WithBroadcastAudio adds a separate app-audio track, never a microphone mix.
// The local preview deliberately has no audio: playing it would create echo.
func WithBroadcastAudio() HubOption { return func(h *Hub) error { h.audioEnabled = true; return nil } }

// WithMaxQueueAge keeps live ReplayKit streams from replaying old screen frames.
// Other native senders keep their existing buffering policy.
func WithMaxQueueAge(age time.Duration) HubOption {
	return func(h *Hub) error {
		if age <= 0 {
			return errors.New("invalid live queue age")
		}
		h.maxQueueAge = age
		return nil
	}
}
func (h *Hub) captureTimestampLocked(pts time.Duration, rate uint32) uint32 {
	if !h.captureStarted {
		h.captureStarted = true
		h.captureOrigin = pts
	}
	elapsed := pts - h.captureOrigin
	if elapsed < 0 {
		elapsed = 0
	}
	// Split seconds to avoid int64 overflow on long captures.
	return uint32(uint64(elapsed/time.Second)*uint64(rate) + uint64(elapsed%time.Second)*uint64(rate)/uint64(time.Second))
}

// WriteOpus fans out one 20 ms packet. The queue holds at most 100 ms and
// replaces the oldest audio on overload; video pacing cannot block audio.
func (h *Hub) WriteOpus(data []byte, pts time.Duration) error {
	if h.closed.Load() || !h.audioEnabled {
		return errors.New("broadcast audio is not active")
	}
	if len(data) == 0 || len(data) > 1275 {
		return errors.New("invalid Opus packet size")
	}
	h.clockMu.Lock()
	stamp := h.captureTimestampLocked(pts, 48000)
	h.clockMu.Unlock()
	frame := &encodedAudio{data: append([]byte(nil), data...), stamp: stamp, arrived: time.Now()}
	h.audioPackets.Add(1)
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, p := range h.peers {
		if p == nil || !p.audioActive || id == PreviewPeerID {
			continue
		}
		select {
		case p.audio <- frame:
		default:
			select {
			case <-p.audio:
				h.audioDropped.Add(1)
			default:
			}
			select {
			case p.audio <- frame:
			default:
				h.audioDropped.Add(1)
			}
		}
	}
	return nil
}
func drainAudioRTCP(ctx context.Context, sender *webrtc.RTPSender) {
	buffer := make([]byte, 1500)
	for ctx.Err() == nil {
		if _, _, err := sender.Read(buffer); err != nil {
			return
		}
	}
}
func (h *Hub) writeAudio(ctx context.Context, p *peer, track *webrtc.TrackLocalStaticRTP) {
	defer close(p.audioDone)
	packetizer := rtp.NewPacketizer(RTPMTU, 0, 0, &codecs.OpusPayloader{}, rtp.NewRandomSequencer(), 48000)
	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-p.audio:
			if time.Since(frame.arrived) > 100*time.Millisecond {
				h.audioDropped.Add(1)
				continue
			}
			for _, packet := range packetizer.Packetize(frame.data, 0) {
				packet.Timestamp = frame.stamp
				if err := track.WriteRTP(packet); err != nil {
					return
				}
			}
		}
	}
}
