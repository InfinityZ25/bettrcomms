package nativertc

import (
	"context"
	"math"
	"strings"
	"time"
)

const (
	// RTPClockRate is H.264's RTP clock.
	RTPClockRate = 90_000
	// RTPMTU keeps a packet inside a common path MTU without fragmenting.
	RTPMTU = 1200
	// RTPWireOverhead is IP, UDP, RTP and SRTP per packet, counted so pacing
	// reflects what actually goes on the wire rather than payload alone.
	RTPWireOverhead = 38
	// PaceHeadroom lets the pacer run above the encoder's nominal rate, so
	// rate-control overshoot does not queue behind the pacer itself.
	PaceHeadroom = 2.5
	// PaceBurst is how much the bucket may hold.
	PaceBurst = 5 * time.Millisecond
	// maxFrameGapTicks bounds a single resynchronisation, so one stall cannot
	// jump the RTP timeline by an amount receivers read as a stream restart.
	maxFrameGapTicks = 10.0 * RTPClockRate
)

// captureClock turns encoder output instants into RTP timestamps.
//
// FFmpeg emits constant-rate frames and several can land in one pipe read, so
// spacing follows the nominal interval rather than arrival. When capture
// genuinely falls behind, the clock resynchronises to the arrival instant
// instead of drifting away from wall time the way a fixed 1/fps step per
// access unit would.
type captureClock struct {
	frameInterval time.Duration
	// frameTicks is the nominal interval in exact 90 kHz ticks. Stepping the
	// grid by this rather than by a nanosecond-truncated duration keeps the
	// common case free of the rounding error a per-frame conversion would
	// accumulate.
	frameTicks  float64
	resyncAfter time.Duration
	cursor      time.Time
	started     bool
	ticks       float64
}

func newCaptureClock(fps uint32) *captureClock {
	if fps == 0 {
		fps = 1
	}
	frameInterval := time.Duration(float64(time.Second) / float64(fps))
	resyncAfter := frameInterval * 3
	if resyncAfter < 25*time.Millisecond {
		resyncAfter = 25 * time.Millisecond
	}
	return &captureClock{
		frameInterval: frameInterval,
		frameTicks:    float64(RTPClockRate) / float64(fps),
		resyncAfter:   resyncAfter,
	}
}

// advance returns the RTP timestamp for a frame that arrived at arrivedAt.
func (c *captureClock) advance(arrivedAt time.Time) uint32 {
	if !c.started {
		c.cursor = arrivedAt
		c.started = true
		return uint32(uint64(c.ticks))
	}

	nominal := c.cursor.Add(c.frameInterval)
	if arrivedAt.After(nominal.Add(c.resyncAfter)) {
		elapsed := arrivedAt.Sub(c.cursor).Seconds()
		if elapsed < 0 {
			elapsed = 0
		}
		c.ticks += math.Min(elapsed*RTPClockRate, maxFrameGapTicks)
		c.cursor = arrivedAt
	} else {
		c.ticks += c.frameTicks
		c.cursor = nominal
	}
	return uint32(uint64(c.ticks))
}

// pacer is a leaky bucket that spreads a large access unit over time instead of
// emitting a keyframe as one burst that shallow path buffers simply drop.
type pacer struct {
	rateBitsPerSecond float64
	burstBits         float64
	tokens            float64
	last              time.Time
	// now and sleep are indirected so pacing can be tested without waiting.
	now   func() time.Time
	sleep func(context.Context, time.Duration) error
}

func newPacer(rateBitsPerSecond float64) *pacer {
	rateBitsPerSecond = math.Max(rateBitsPerSecond, 1_000)
	// The bucket must hold at least a few whole packets, or a single packet
	// could never be affordable and the writer would spin.
	burstBits := math.Max(
		rateBitsPerSecond*PaceBurst.Seconds(),
		4*float64(RTPMTU+RTPWireOverhead)*8,
	)
	return &pacer{
		rateBitsPerSecond: rateBitsPerSecond,
		burstBits:         burstBits,
		tokens:            burstBits,
		last:              time.Now(),
		now:               time.Now,
		sleep:             sleepContext,
	}
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// consume waits until the bucket can afford bits, then spends them.
func (p *pacer) consume(ctx context.Context, bits float64) error {
	// A packet larger than the whole bucket must still be sendable, or the
	// writer would never make progress.
	bits = math.Min(bits, p.burstBits)
	for {
		now := p.now()
		refill := now.Sub(p.last).Seconds() * p.rateBitsPerSecond
		if refill < 0 {
			refill = 0
		}
		p.tokens = math.Min(p.tokens+refill, p.burstBits)
		p.last = now
		if p.tokens >= bits {
			p.tokens -= bits
			return nil
		}
		wait := time.Duration((bits - p.tokens) / p.rateBitsPerSecond * float64(time.Second))
		if err := p.sleep(ctx, wait); err != nil {
			return err
		}
	}
}

// isRelayCandidate reports whether an ICE candidate line is a TURN relay.
func isRelayCandidate(candidate string) bool {
	fields := strings.Fields(strings.ToLower(candidate))
	for index := 0; index+1 < len(fields); index++ {
		if fields[index] == "typ" && fields[index+1] == "relay" {
			return true
		}
	}
	return false
}

// withoutRelayCandidates strips TURN relay candidates from an SDP.
//
// "Direct only" is a privacy choice: it keeps media off a third-party relay
// even at the cost of failing to connect. Filtering the SDP rather than the
// ICE agent is what makes the choice visible to the other side too.
func withoutRelayCandidates(sdp string) string {
	separator := "\n"
	if strings.Contains(sdp, "\r\n") {
		separator = "\r\n"
	}
	trailing := strings.HasSuffix(sdp, separator)

	lines := strings.Split(strings.TrimSuffix(sdp, separator), separator)
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(line, "a=candidate:") && isRelayCandidate(line) {
			continue
		}
		kept = append(kept, line)
	}
	filtered := strings.Join(kept, separator)
	if trailing {
		filtered += separator
	}
	return filtered
}
