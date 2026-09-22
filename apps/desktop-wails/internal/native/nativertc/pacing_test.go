package nativertc

import (
	"context"
	"strings"
	"testing"
	"time"
)

// Several access units routinely arrive in one pipe read. Their spacing must
// stay on the encoder's grid rather than collapsing to zero, or the receiver
// plays them all at once.
func TestCaptureClockHoldsTheNominalGridAndResynchronisesAfterAStall(t *testing.T) {
	clock := newCaptureClock(120)
	start := time.Now()

	if got := clock.advance(start); got != 0 {
		t.Errorf("the first frame is at %d, want 0", got)
	}

	burst := start.Add(9 * time.Millisecond)
	for index, want := range []uint32{750, 1_500, 2_250} {
		if got := clock.advance(burst); got != want {
			t.Errorf("burst frame %d is at %d, want %d", index, got, want)
		}
	}

	// A genuine stall must move the clock by the real elapsed time, so the
	// receiver's playout does not drift permanently behind wall time.
	stalled := clock.advance(burst.Add(500 * time.Millisecond))
	if stalled < 44_000 || stalled > 46_000 {
		t.Errorf("a 500 ms stall advanced %d ticks, want about 45000", stalled)
	}
}

// One gap must not jump the timeline by an amount a receiver reads as a stream
// restart.
func TestCaptureClockNeverLetsOneGapRunAway(t *testing.T) {
	clock := newCaptureClock(60)
	start := time.Now()
	clock.advance(start)

	if got := clock.advance(start.Add(600 * time.Second)); uint64(got) != uint64(maxFrameGapTicks) {
		t.Errorf("a ten-minute gap advanced %d ticks, want the %d cap", got, uint64(maxFrameGapTicks))
	}
}

// A frame arriving early or exactly on the grid must not resynchronise: that
// would make the timeline follow pipe scheduling instead of the encoder.
func TestCaptureClockIgnoresJitterInsideTheResyncWindow(t *testing.T) {
	clock := newCaptureClock(60)
	start := time.Now()
	clock.advance(start)

	// 60 fps is a 16.6 ms interval and a 50 ms resync window.
	if got := clock.advance(start.Add(30 * time.Millisecond)); got != 1_500 {
		t.Errorf("a jittered frame is at %d, want the nominal 1500", got)
	}
}

// fakeClock drives the pacer without waiting.
type fakeClock struct{ now time.Time }

func (f *fakeClock) Now() time.Time { return f.now }

func (f *fakeClock) Sleep(_ context.Context, duration time.Duration) error {
	f.now = f.now.Add(duration)
	return nil
}

// Draining a keyframe must take real time — that is the whole point — and must
// still finish promptly enough not to throttle below the target rate.
func TestPacerSpreadsABurstWithoutStallingOnASinglePacket(t *testing.T) {
	fake := &fakeClock{now: time.Now()}
	paced := newPacer(20_000_000 * PaceHeadroom)
	paced.now = fake.Now
	paced.sleep = fake.Sleep
	paced.last = fake.now

	started := fake.now
	packetBits := float64(RTPMTU+RTPWireOverhead) * 8
	// A 2 Mbit keyframe is about 200 packets at this MTU.
	for range 200 {
		if err := paced.consume(context.Background(), packetBits); err != nil {
			t.Fatalf("consume: %v", err)
		}
	}
	elapsed := fake.now.Sub(started)

	if elapsed < 5*time.Millisecond {
		t.Errorf("pacing did not spread the burst, took %v", elapsed)
	}
	if elapsed > 400*time.Millisecond {
		t.Errorf("pacing throttled below the target rate, took %v", elapsed)
	}

	// A packet larger than the whole bucket must still be sendable, or the
	// writer would spin forever on it.
	if err := paced.consume(context.Background(), paced.burstBits*4); err != nil {
		t.Fatalf("an oversized packet was never affordable: %v", err)
	}
}

// A cancelled context must abandon pacing rather than hold the writer.
func TestPacerStopsWhenItsContextIsCancelled(t *testing.T) {
	paced := newPacer(1_000)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	// The bucket starts full, so the first packet is always affordable and
	// never sleeps. Drain it to reach the path that waits.
	if err := paced.consume(context.Background(), paced.burstBits); err != nil {
		t.Fatalf("draining the bucket: %v", err)
	}
	if err := paced.consume(ctx, paced.burstBits); err == nil {
		t.Error("pacing continued after its context was cancelled")
	}
}

// The first packet after the bucket is created is always affordable: a writer
// must not wait before its very first send.
func TestPacerAdmitsTheFirstPacketImmediately(t *testing.T) {
	fake := &fakeClock{now: time.Now()}
	paced := newPacer(1_000)
	paced.now = fake.Now
	paced.sleep = fake.Sleep
	paced.last = fake.now

	if err := paced.consume(context.Background(), float64(RTPMTU+RTPWireOverhead)*8); err != nil {
		t.Fatalf("consume: %v", err)
	}
	if fake.now != paced.last {
		t.Error("the first packet waited")
	}
}

// The bucket must hold at least a few whole packets at any rate, or a single
// packet could never be affordable.
func TestPacerBucketAlwaysHoldsWholePackets(t *testing.T) {
	for _, rate := range []float64{0, 1, 1_000, 100_000_000} {
		paced := newPacer(rate)
		minimum := 4 * float64(RTPMTU+RTPWireOverhead) * 8
		if paced.burstBits < minimum {
			t.Errorf("rate %v gives a %v-bit bucket, want at least %v", rate, paced.burstBits, minimum)
		}
	}
}

func TestIsRelayCandidateRecognisesTURN(t *testing.T) {
	relay := "a=candidate:1 1 udp 41885439 203.0.113.7 51000 typ relay raddr 0.0.0.0 rport 0"
	host := "a=candidate:2 1 udp 2130706431 192.168.1.20 54321 typ host"

	if !isRelayCandidate(relay) {
		t.Error("a relay candidate was not recognised")
	}
	if isRelayCandidate(host) {
		t.Error("a host candidate was treated as a relay")
	}
	// "relay" appearing anywhere but after "typ" is not a relay candidate.
	if isRelayCandidate("a=candidate:3 1 udp 1 relay.example 1 typ host") {
		t.Error("a hostname containing 'relay' was treated as a relay candidate")
	}
}

// Direct-only is a privacy choice: media must not touch a third-party relay
// even at the cost of failing to connect.
func TestDirectOnlyRemovesRelayLines(t *testing.T) {
	sdp := strings.Join([]string{
		"v=0",
		"a=candidate:1 1 udp 2130706431 192.168.1.20 54321 typ host",
		"a=candidate:2 1 udp 41885439 203.0.113.7 51000 typ relay",
		"a=end-of-candidates",
	}, "\r\n") + "\r\n"

	filtered := withoutRelayCandidates(sdp)

	if strings.Contains(filtered, "typ relay") {
		t.Errorf("a relay candidate survived: %s", filtered)
	}
	for _, want := range []string{"v=0", "typ host", "a=end-of-candidates"} {
		if !strings.Contains(filtered, want) {
			t.Errorf("filtering removed %q: %s", want, filtered)
		}
	}
	if !strings.HasSuffix(filtered, "\r\n") {
		t.Error("the trailing separator was lost")
	}
	if strings.Contains(filtered, "\r\n\r\n") {
		t.Error("filtering left a blank line where a candidate was removed")
	}
}

func TestFilteringPreservesLineEndings(t *testing.T) {
	unix := "v=0\na=candidate:2 1 udp 1 203.0.113.7 1 typ relay\na=end-of-candidates"
	filtered := withoutRelayCandidates(unix)

	if strings.Contains(filtered, "\r\n") {
		t.Error("LF input came back with CRLF")
	}
	if strings.Contains(filtered, "typ relay") {
		t.Error("a relay candidate survived")
	}
}
