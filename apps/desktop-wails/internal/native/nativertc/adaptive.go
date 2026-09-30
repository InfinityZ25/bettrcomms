package nativertc

import (
	"errors"
	"math"
	"sync"
	"time"
)

const feedbackLifetime = 5 * time.Second

// WithAdaptiveBitrate enables conservative loss/REMB-driven rate control.
// It is not a transport-wide bandwidth estimator. The codec is still negotiated
// for the maximum rate. EncoderControl must be applied by the native encoder.
func WithAdaptiveBitrate(minimum, initial, maximum int) HubOption {
	return func(h *Hub) error {
		if minimum <= 0 || minimum > initial || initial > maximum || float64(maximum) > h.paceBitsPerSecond/PaceHeadroom {
			return errors.New("invalid native adaptive bitrate bounds")
		}
		h.adaptive = newBitrateController(minimum, initial, maximum)
		return nil
	}
}

type HubOption func(*Hub) error

type receiverFeedback struct {
	reportAt   time.Time
	loss       uint8 // RFC 3550 fraction lost, in units of 1/256.
	estimateAt time.Time
	estimate   int
}

type bitrateController struct {
	sync.Mutex
	minimum, maximum, current              int
	peers                                  map[string]receiverFeedback
	nextDecision, healthySince, lastReport time.Time
	congestedAt, lastCongestion            time.Time
}

func newBitrateController(minimum, initial, maximum int) *bitrateController {
	return &bitrateController{minimum: minimum, maximum: maximum, current: initial, peers: map[string]receiverFeedback{}}
}
func (c *bitrateController) add(id string) {
	c.Lock()
	defer c.Unlock()
	c.peers[id] = receiverFeedback{}
	c.healthySince = time.Time{}
}
func (c *bitrateController) remove(id string) {
	c.Lock()
	defer c.Unlock()
	delete(c.peers, id)
	c.healthySince = time.Time{}
}
func (c *bitrateController) report(id string, loss uint8, now time.Time) {
	c.Lock()
	defer c.Unlock()
	f, ok := c.peers[id]
	if !ok {
		return
	}
	f.loss = loss
	f.reportAt = now
	c.peers[id] = f
}
func (c *bitrateController) estimate(id string, bits float32, now time.Time) {
	if bits <= 0 || math.IsNaN(float64(bits)) || math.IsInf(float64(bits), 0) {
		return
	}
	c.Lock()
	defer c.Unlock()
	f, ok := c.peers[id]
	if !ok {
		return
	}
	f.estimate = int(math.Min(float64(bits)*0.85, float64(c.maximum)))
	f.estimateAt = now
	c.peers[id] = f
}
func (c *bitrateController) congested(now time.Time) {
	c.Lock()
	defer c.Unlock()
	c.congestedAt = now
}
func (c *bitrateController) rate(now time.Time) int {
	c.Lock()
	defer c.Unlock()
	if now.Before(c.nextDecision) {
		return c.current
	}
	ceiling := c.maximum
	healthy := len(c.peers) > 0
	var loss uint8
	newest := c.lastReport
	for _, f := range c.peers {
		if !f.estimateAt.IsZero() && now.Sub(f.estimateAt) <= feedbackLifetime {
			ceiling = min(ceiling, max(c.minimum, f.estimate))
		}
		if f.reportAt.IsZero() || now.Sub(f.reportAt) > feedbackLifetime {
			healthy = false
			continue
		}
		loss = max(loss, f.loss)
		if f.reportAt.After(newest) {
			newest = f.reportAt
		}
	}
	target := min(c.current, ceiling)
	if c.congestedAt.After(c.lastCongestion) {
		target = min(target, c.current*4/5)
		healthy = false
		c.lastCongestion = c.congestedAt
	}
	// Act on each new report only once. A stale high-loss sample must not keep
	// multiplying the rate downward on every camera frame.
	if newest.After(c.lastReport) && loss >= 13 {
		target = min(target, c.current*4/5)
		healthy = false
	}
	if loss >= 5 {
		healthy = false
	}
	if !healthy {
		c.healthySince = time.Time{}
	} else if c.healthySince.IsZero() {
		c.healthySince = now
	}
	if healthy && newest.After(c.lastReport) && now.Sub(c.healthySince) >= 8*time.Second {
		target = min(ceiling, c.current+250_000)
	}
	c.lastReport = newest
	target = max(c.minimum, target)
	if target != c.current {
		c.current = target
		c.nextDecision = now.Add(2 * time.Second)
	}
	return c.current
}

// EncoderControl is polled on native camera frames, so it works without JS
// timers while the app is backgrounded. A storm of PLI/FIR requests is coalesced.
type EncoderControl struct {
	Bitrate       int
	ForceKeyframe bool
}

func (h *Hub) NextEncoderControl(now time.Time) EncoderControl {
	h.controlMu.Lock()
	defer h.controlMu.Unlock()
	var result EncoderControl
	if h.closed.Load() {
		return result
	}
	if h.adaptive != nil {
		result.Bitrate = h.adaptive.rate(now)
	}
	if !now.Before(h.nextKeyframe) && h.TakeIDRRequest() {
		result.ForceKeyframe = true
		h.nextKeyframe = now.Add(500 * time.Millisecond)
	}
	return result
}
func (h *Hub) pacingRate(now time.Time) float64 {
	if h.adaptive != nil {
		return float64(h.adaptive.rate(now)) * 1.25
	}
	return h.paceBitsPerSecond
}
