package nativertc

import (
	"bettercomms/desktop-wails/internal/native/h264"
	"context"
	"github.com/pion/rtcp"
	"testing"
	"time"
)

func TestAdaptiveRateGrowsOnlyWithFreshHealthyFeedback(t *testing.T) {
	c := newBitrateController(1_000_000, 3_000_000, 8_000_000)
	now := time.Unix(100, 0)
	if got := c.rate(now); got != 3_000_000 {
		t.Fatal(got)
	}
	c.add("viewer")
	for second := 0; second <= 8; second++ {
		at := now.Add(time.Duration(second) * time.Second)
		c.report("viewer", 0, at)
		got := c.rate(at)
		if second < 8 && got != 3_000_000 {
			t.Fatalf("premature ramp at %d: %d", second, got)
		}
	}
	if got := c.rate(now.Add(8 * time.Second)); got != 3_250_000 {
		t.Fatal(got)
	}
	// Neither a timer nor lack of feedback may increase the bitrate.
	if got := c.rate(now.Add(20 * time.Second)); got != 3_250_000 {
		t.Fatal(got)
	}
	c.report("viewer", 0, now.Add(21*time.Second))
	if got := c.rate(now.Add(21 * time.Second)); got != 3_250_000 {
		t.Fatalf("stale health history: %d", got)
	}
}
func TestAdaptiveRateBacksOffOncePerLossReportAndHonorsBounds(t *testing.T) {
	c := newBitrateController(1_000_000, 3_000_000, 8_000_000)
	c.add("viewer")
	now := time.Unix(100, 0)
	c.report("viewer", 26, now)
	if got := c.rate(now); got != 2_400_000 {
		t.Fatal(got)
	}
	if got := c.rate(now.Add(3 * time.Second)); got != 2_400_000 {
		t.Fatalf("reused loss report: %d", got)
	}
	for i := 1; i < 30; i++ {
		at := now.Add(time.Duration(i) * 3 * time.Second)
		c.report("viewer", 64, at)
		c.rate(at)
	}
	if got := c.rate(now.Add(100 * time.Second)); got != 1_000_000 {
		t.Fatal(got)
	}
}
func TestAdaptiveRateUsesTheMostConstrainedViewerAndRemovesIt(t *testing.T) {
	c := newBitrateController(1_000_000, 3_000_000, 8_000_000)
	c.add("fast")
	c.add("slow")
	now := time.Unix(100, 0)
	c.report("fast", 0, now)
	c.report("slow", 0, now)
	c.estimate("fast", 9_000_000, now)
	c.estimate("slow", 2_000_000, now)
	if got := c.rate(now); got != 1_700_000 {
		t.Fatal(got)
	}
	c.remove("slow")
	for second := 3; second <= 13; second++ {
		at := now.Add(time.Duration(second) * time.Second)
		c.report("fast", 0, at)
		c.rate(at)
	}
	if got := c.rate(now.Add(13 * time.Second)); got <= 1_700_000 {
		t.Fatalf("removed peer still limits rate: %d", got)
	}
}
func TestAdaptiveRateMissingViewerBlocksRampAndQueuesBackOff(t *testing.T) {
	c := newBitrateController(1_000_000, 3_000_000, 8_000_000)
	c.add("fast")
	c.add("silent")
	now := time.Unix(100, 0)
	for i := 0; i <= 12; i++ {
		at := now.Add(time.Duration(i) * time.Second)
		c.report("fast", 0, at)
		if c.rate(at) != 3_000_000 {
			t.Fatal("ramped without all viewer reports")
		}
	}
	c.congested(now.Add(13 * time.Second))
	if got := c.rate(now.Add(13 * time.Second)); got != 2_400_000 {
		t.Fatal(got)
	}
	if got := c.rate(now.Add(16 * time.Second)); got != 2_400_000 {
		t.Fatalf("reused local congestion: %d", got)
	}
}
func TestNativeEncoderControlCoalescesRequestsAndStopsOnClose(t *testing.T) {
	hub, err := NewHub("test", h264.Baseline, 720, 1280, 30, 8, WithAdaptiveBitrate(1_000_000, 3_000_000, 8_000_000))
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	now := time.Unix(100, 0)
	hub.idrRequested.Store(true)
	first := hub.NextEncoderControl(now)
	if !first.ForceKeyframe || first.Bitrate != 3_000_000 {
		t.Fatal(first)
	}
	hub.idrRequested.Store(true)
	if hub.NextEncoderControl(now.Add(100 * time.Millisecond)).ForceKeyframe {
		t.Fatal("PLI storm was not throttled")
	}
	if !hub.NextEncoderControl(now.Add(500 * time.Millisecond)).ForceKeyframe {
		t.Fatal("pending PLI was lost")
	}
	hub.Close()
	hub.idrRequested.Store(true)
	if got := hub.NextEncoderControl(now.Add(time.Second)); got.Bitrate != 0 || got.ForceKeyframe {
		t.Fatal(got)
	}
}
func TestAdaptiveBoundsAndFeedback(t *testing.T) {
	if _, err := NewHub("test", h264.Baseline, 720, 1280, 30, 3, WithAdaptiveBitrate(1_000_000, 3_000_000, 8_000_000)); err == nil {
		t.Fatal("adaptive ceiling exceeds negotiated bitrate")
	}
	hub, err := NewHub("test", h264.Baseline, 720, 1280, 30, 8, WithAdaptiveBitrate(1_000_000, 3_000_000, 8_000_000))
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	found := false
	for _, f := range hub.codec.RTCPFeedback {
		found = found || f.Type == "goog-remb"
	}
	if !found {
		t.Fatal("adaptive receiver estimate not negotiated")
	}
}
func TestPacerRateChangeDoesNotGrantAFreeBurst(t *testing.T) {
	p := newPacer(10_000_000)
	p.tokens = 0
	p.setRate(2_000_000)
	if p.tokens > 1000 {
		t.Fatal("rate change refilled bucket")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if p.consume(ctx, p.burstBits) == nil {
		t.Fatal("cancelled writer kept running")
	}
}

func TestNativeFeedbackDispatchMatchesVideoSSRC(t *testing.T) {
	h, err := NewHub("test", h264.Baseline, 720, 1280, 30, 8, WithAdaptiveBitrate(1_000_000, 3_000_000, 8_000_000))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	h.adaptive.add("viewer")
	now := time.Unix(100, 0)
	h.handleFeedback("viewer", 42, []rtcp.Packet{&rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{SSRC: 99, FractionLost: 100}}}, &rtcp.ReceiverEstimatedMaximumBitrate{SSRCs: []uint32{99}, Bitrate: 1_000_000}}, now)
	if got := h.NextEncoderControl(now); got.Bitrate != 3_000_000 {
		t.Fatal("foreign SSRC affected video", got)
	}
	h.handleFeedback("viewer", 42, []rtcp.Packet{&rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{SSRC: 42, FractionLost: 26}}}, &rtcp.PictureLossIndication{MediaSSRC: 42}}, now)
	if got := h.NextEncoderControl(now); got.Bitrate != 2_400_000 || !got.ForceKeyframe {
		t.Fatal("loss/PLI not dispatched", got)
	}
	h.handleFeedback("viewer", 42, []rtcp.Packet{&rtcp.ReceiverEstimatedMaximumBitrate{SSRCs: []uint32{42}, Bitrate: 1_500_000}}, now.Add(3*time.Second))
	if got := h.NextEncoderControl(now.Add(3 * time.Second)); got.Bitrate != 1_275_000 {
		t.Fatal("REMB was not applied", got)
	}
}
