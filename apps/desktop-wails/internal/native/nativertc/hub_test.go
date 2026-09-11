package nativertc

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"bettercomms/desktop-wails/internal/native/h264"

	"github.com/pion/webrtc/v4"
)

func newTestHub(t *testing.T) *Hub {
	t.Helper()
	hub, err := NewHub("test-session", h264.Baseline, 1280, 720, 30, 8)
	if err != nil {
		t.Fatalf("NewHub: %v", err)
	}
	t.Cleanup(hub.Close)
	return hub
}

// The fmtp the offer carries must announce exactly the profile and level the
// encoder is configured for. A receiver that trusts a level the sender does not
// honour will fail to decode.
func TestH264FmtpMatchesProfileLevelAndBitrate(t *testing.T) {
	for _, test := range []struct {
		name                            string
		profile                         h264.Profile
		width, height, fps, bitrateMbps uint32
		want                            string
	}{
		{"720p60 baseline", h264.Baseline, 1280, 720, 60, 20, "42e020"},
		{"1080p60 high", h264.High, 1920, 1080, 60, 20, "64002a"},
		{"1080p60 high at 80 Mbps", h264.High, 1920, 1080, 60, 80, "640032"},
		{"4K60 high", h264.High, 3840, 2160, 60, 80, "640034"},
		{"1080p60 main", h264.Main, 1920, 1080, 60, 20, "4d002a"},
		{"720p240 high", h264.High, 1280, 720, 240, 20, "640033"},
		{"1080p120 high", h264.High, 1920, 1080, 120, 20, "640033"},
	} {
		t.Run(test.name, func(t *testing.T) {
			codec, err := h264Codec(test.profile, test.width, test.height, test.fps, test.bitrateMbps)
			if err != nil {
				t.Fatalf("h264Codec: %v", err)
			}
			if !strings.Contains(codec.SDPFmtpLine, "profile-level-id="+test.want) {
				t.Errorf("fmtp = %q, want profile-level-id=%s", codec.SDPFmtpLine, test.want)
			}
			if !strings.Contains(codec.SDPFmtpLine, "packetization-mode=1") {
				t.Errorf("fmtp = %q, want packetization-mode=1", codec.SDPFmtpLine)
			}
		})
	}

	// Settings past level 5.2 must be refused rather than advertised wrongly.
	if _, err := h264Codec(h264.High, 2560, 1440, 240, 20); err == nil {
		t.Error("settings beyond level 5.2 produced a codec")
	}
}

// The offer must advertise exactly the feedback this sender implements.
// Advertising congestion control with no estimator behind it invites reports
// nothing acts on.
func TestTheOfferAdvertisesOnlyImplementedFeedback(t *testing.T) {
	codec, err := h264Codec(h264.Baseline, 1280, 720, 30, 8)
	if err != nil {
		t.Fatalf("h264Codec: %v", err)
	}
	var kinds []string
	for _, feedback := range codec.RTCPFeedback {
		kinds = append(kinds, strings.TrimSpace(feedback.Type+" "+feedback.Parameter))
	}
	slices.Sort(kinds)
	want := []string{"ccm fir", "nack", "nack pli"}
	if !slices.Equal(kinds, want) {
		t.Errorf("feedback = %v, want %v", kinds, want)
	}
}

func TestNewHubRejectsBadArguments(t *testing.T) {
	if _, err := NewHub("", h264.Baseline, 1280, 720, 30, 8); err == nil {
		t.Error("an empty session id was accepted")
	}
	if _, err := NewHub("has space", h264.Baseline, 1280, 720, 30, 8); err == nil {
		t.Error("a session id with a space was accepted")
	}
	if _, err := NewHub("session", h264.Baseline, 1280, 720, 0, 8); err == nil {
		t.Error("a zero frame rate was accepted")
	}
}

// An offer must be complete when it is returned: the page relays one
// description rather than trickling from this side.
func TestCreatePeerProducesACompleteOffer(t *testing.T) {
	hub := newTestHub(t)

	offer, err := hub.CreatePeer(context.Background(), "viewer", nil, true)
	if err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	if offer.PeerID != "viewer" {
		t.Errorf("peer id = %q", offer.PeerID)
	}
	for _, want := range []string{"m=video", "H264", "profile-level-id="} {
		if !strings.Contains(offer.SDP, want) {
			t.Errorf("the offer is missing %q", want)
		}
	}
	if hub.PeerCount() != 1 {
		t.Errorf("peer count = %d, want 1", hub.PeerCount())
	}
}

func TestCreatePeerRejectsDuplicatesAndBadIDs(t *testing.T) {
	hub := newTestHub(t)

	if _, err := hub.CreatePeer(context.Background(), "viewer", nil, true); err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	if _, err := hub.CreatePeer(context.Background(), "viewer", nil, true); err == nil {
		t.Error("a duplicate peer id was accepted")
	}
	if _, err := hub.CreatePeer(context.Background(), "has space", nil, true); err == nil {
		t.Error("an invalid peer id was accepted")
	}
}

// The peer limit exists because each viewer costs a connection, a track, a
// queue and a goroutine.
func TestThePeerLimitIsEnforced(t *testing.T) {
	hub := newTestHub(t)

	for index := range MaxPeers {
		if _, err := hub.CreatePeer(context.Background(), "viewer-"+itoa(index), nil, true); err != nil {
			t.Fatalf("peer %d: %v", index, err)
		}
	}
	if _, err := hub.CreatePeer(context.Background(), "one-too-many", nil, true); err == nil {
		t.Error("the peer limit was exceeded")
	} else if !strings.Contains(err.Error(), "limit") {
		t.Errorf("err = %v, want the limit reason", err)
	}

	// Removing one makes room again.
	if err := hub.RemovePeer("viewer-0"); err != nil {
		t.Fatalf("RemovePeer: %v", err)
	}
	if _, err := hub.CreatePeer(context.Background(), "replacement", nil, true); err != nil {
		t.Errorf("a freed slot was not reusable: %v", err)
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// Direct-only must not configure a TURN server at all. Deprioritising one still
// leaves media able to traverse it.
func TestDirectOnlyConfiguresNoTURNServer(t *testing.T) {
	servers := []IceServer{
		{URLs: []string{"stun:stun.example:3478"}},
		{URLs: []string{"turn:turn.example:3478"}, Username: "user", Credential: "secret"},
		{URLs: []string{"turns:turn.example:5349", "stun:stun.example:3478"}},
	}

	direct := prepareICEServers(servers, true)
	for _, server := range direct {
		for _, url := range server.URLs {
			if strings.HasPrefix(strings.ToLower(url), "turn") {
				t.Errorf("direct-only kept a relay: %s", url)
			}
		}
	}

	relayed := prepareICEServers(servers, false)
	var sawTURN bool
	for _, server := range relayed {
		for _, url := range server.URLs {
			if strings.HasPrefix(strings.ToLower(url), "turn") {
				sawTURN = true
			}
		}
	}
	if !sawTURN {
		t.Error("the relayed configuration dropped its TURN servers")
	}
}

// This is the end-to-end claim: a real pion receiver negotiates with the native
// sender and receives real H.264 RTP.
func TestAViewerNegotiatesAndReceivesVideo(t *testing.T) {
	hub := newTestHub(t)

	offer, err := hub.CreatePeer(context.Background(), "viewer", nil, true)
	if err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}

	viewer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("viewer: %v", err)
	}
	defer func() { _ = viewer.Close() }()

	received := make(chan *webrtc.TrackRemote, 1)
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		select {
		case received <- track:
		default:
		}
	})

	if err := viewer.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer, SDP: offer.SDP,
	}); err != nil {
		t.Fatalf("SetRemoteDescription: %v", err)
	}
	answer, err := viewer.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("CreateAnswer: %v", err)
	}
	gathering := webrtc.GatheringCompletePromise(viewer)
	if err := viewer.SetLocalDescription(answer); err != nil {
		t.Fatalf("SetLocalDescription: %v", err)
	}
	<-gathering

	if err := hub.ApplyAnswer("viewer", viewer.LocalDescription().SDP); err != nil {
		t.Fatalf("ApplyAnswer: %v", err)
	}

	// Feed keyframes until the viewer sees one. Connection setup takes a moment
	// and frames written before it completes are simply dropped.
	deadline := time.Now().Add(20 * time.Second)
	var track *webrtc.TrackRemote
	for track == nil && time.Now().Before(deadline) {
		if err := hub.WriteAccessUnit(keyframeUnit(), time.Now()); err != nil {
			t.Fatalf("WriteAccessUnit: %v", err)
		}
		select {
		case track = <-received:
		case <-time.After(50 * time.Millisecond):
		}
	}
	if track == nil {
		t.Fatal("the viewer never received a track")
	}
	if !strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeH264) {
		t.Errorf("track codec = %s, want H264", track.Codec().MimeType)
	}

	// And real packets arrive on it.
	go func() {
		for time.Now().Before(deadline) {
			_ = hub.WriteAccessUnit(keyframeUnit(), time.Now())
			time.Sleep(20 * time.Millisecond)
		}
	}()
	_ = track.SetReadDeadline(time.Now().Add(15 * time.Second))
	packet, _, err := track.ReadRTP()
	if err != nil {
		t.Fatalf("ReadRTP: %v", err)
	}
	if len(packet.Payload) == 0 {
		t.Error("an empty RTP payload arrived")
	}
}

// A viewer that cannot keep up drops its own frames. Blocking here would let
// one congested viewer stall capture for everybody.
func TestAStalledViewerDropsItsOwnFramesInsteadOfBlockingCapture(t *testing.T) {
	hub := newTestHub(t)

	if _, err := hub.CreatePeer(context.Background(), "viewer", nil, true); err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}

	// Stop this viewer's writer so nothing drains its queue. That is the
	// "viewer cannot keep up" case, without depending on how fast an
	// unconnected track discards writes.
	attached, err := hub.peer("viewer")
	if err != nil {
		t.Fatalf("peer: %v", err)
	}
	attached.cancel()
	<-attached.done

	// Far more frames than the queue holds must still be accepted promptly.
	started := time.Now()
	for range peerQueueFrames * 4 {
		if err := hub.WriteAccessUnit(keyframeUnit(), time.Now()); err != nil {
			t.Fatalf("WriteAccessUnit: %v", err)
		}
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Errorf("capture was blocked for %v by a viewer that could not keep up", elapsed)
	}
	if hub.droppedFrames.Load() == 0 {
		t.Error("no frames were dropped, so the queue must have grown without bound")
	}
	if attached.droppedFrames.Load() == 0 {
		t.Error("the stalled viewer's own drop count was not recorded")
	}
	// The viewer is marked to resume at a keyframe: after an overflow its
	// reference chain is broken and delta frames would render as smearing.
	if !attached.resync.Load() {
		t.Error("the viewer was not marked for resync after dropping frames")
	}
}

func TestWriteAccessUnitRejectsMalformedInput(t *testing.T) {
	hub := newTestHub(t)

	if err := hub.WriteAccessUnit([]byte{0x65, 0x88}, time.Now()); err == nil {
		t.Error("a unit with no start code was accepted")
	}
	oversized := make([]byte, MaxAccessUnitBytes+1)
	copy(oversized, []byte{0, 0, 0, 1, nalSliceIDR})
	if err := hub.WriteAccessUnit(oversized, time.Now()); err == nil {
		t.Error("an oversized unit was accepted")
	}
}

func TestAClosedHubAcceptsNothingMore(t *testing.T) {
	hub, err := NewHub("closing", h264.Baseline, 1280, 720, 30, 8)
	if err != nil {
		t.Fatalf("NewHub: %v", err)
	}
	if _, err := hub.CreatePeer(context.Background(), "viewer", nil, true); err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	hub.Close()

	if hub.PeerCount() != 0 {
		t.Errorf("peer count = %d after close, want 0", hub.PeerCount())
	}
	if err := hub.WriteAccessUnit(keyframeUnit(), time.Now()); err == nil {
		t.Error("a closed hub accepted a frame")
	}
	if _, err := hub.CreatePeer(context.Background(), "late", nil, true); err == nil {
		t.Error("a closed hub accepted a peer")
	}
}

// A keyframe request from a viewer is answered by restarting capture, so it
// must be reported once and then cleared.
func TestIDRRequestsAreTakenOnce(t *testing.T) {
	hub := newTestHub(t)

	if hub.TakeIDRRequest() {
		t.Error("a fresh hub reported a pending keyframe request")
	}
	hub.idrRequested.Store(true)
	if !hub.TakeIDRRequest() {
		t.Error("a pending request was not reported")
	}
	if hub.TakeIDRRequest() {
		t.Error("the request was reported twice, which would restart capture twice")
	}
}

// Candidates arriving before the answer must be held, not discarded: one of
// them may be the only path that works.
func TestCandidatesBeforeTheAnswerAreQueued(t *testing.T) {
	hub := newTestHub(t)
	if _, err := hub.CreatePeer(context.Background(), "viewer", nil, false); err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}

	candidate := IceCandidate{Candidate: "candidate:1 1 udp 2130706431 192.168.1.20 54321 typ host"}
	if err := hub.AddCandidate("viewer", candidate); err != nil {
		t.Fatalf("AddCandidate: %v", err)
	}

	attached, err := hub.peer("viewer")
	if err != nil {
		t.Fatalf("peer: %v", err)
	}
	attached.signaling.mu.Lock()
	queued := len(attached.signaling.pendingCandidates)
	attached.signaling.mu.Unlock()
	if queued != 1 {
		t.Errorf("%d candidates queued, want 1", queued)
	}
}

// Direct-only refuses a relay candidate from the other side too.
func TestDirectOnlyDropsARemoteRelayCandidate(t *testing.T) {
	hub := newTestHub(t)
	if _, err := hub.CreatePeer(context.Background(), "viewer", nil, true); err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}

	relay := IceCandidate{Candidate: "candidate:2 1 udp 41885439 203.0.113.7 51000 typ relay"}
	if err := hub.AddCandidate("viewer", relay); err != nil {
		t.Fatalf("AddCandidate: %v", err)
	}

	attached, err := hub.peer("viewer")
	if err != nil {
		t.Fatalf("peer: %v", err)
	}
	attached.signaling.mu.Lock()
	queued := len(attached.signaling.pendingCandidates)
	attached.signaling.mu.Unlock()
	if queued != 0 {
		t.Errorf("a relay candidate was queued under direct-only")
	}
}

func TestOperationsOnAnUnknownPeerFail(t *testing.T) {
	hub := newTestHub(t)

	if err := hub.ApplyAnswer("nobody", "v=0"); err == nil {
		t.Error("an answer for an unknown peer was accepted")
	}
	if err := hub.AddCandidate("nobody", IceCandidate{Candidate: "candidate:1"}); err == nil {
		t.Error("a candidate for an unknown peer was accepted")
	}
	// Removing one that is not there is not an error: the goal is that it is gone.
	if err := hub.RemovePeer("nobody"); err != nil {
		t.Errorf("RemovePeer: %v", err)
	}
}
