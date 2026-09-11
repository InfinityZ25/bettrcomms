package nativertc

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"bettercomms/desktop-wails/internal/native/h264"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

const (
	// MaxPeers bounds how many viewers one capture serves. Each costs a peer
	// connection, a track, a queue and a writer goroutine.
	MaxPeers = 8
	// iceGatherTimeout bounds how long an offer waits for candidates.
	iceGatherTimeout = 15 * time.Second
	// peerQueueFrames is one viewer's backlog. A viewer that cannot keep up
	// drops its own frames here rather than stalling the encoder pipe for
	// everybody.
	peerQueueFrames = 16
	// PreviewPeerID is the local self-view, which never leaves the machine.
	PreviewPeerID = "__preview"
)

// IceServer is an ICE server as the page supplies it.
type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

// IceCandidate is a trickled candidate from the viewer.
type IceCandidate struct {
	Candidate     string  `json:"candidate"`
	SDPMid        *string `json:"sdpMid"`
	SDPMLineIndex *uint16 `json:"sdpMLineIndex"`
}

// Offer is what the page relays to the viewer.
type Offer struct {
	PeerID string `json:"peerId"`
	SDP    string `json:"sdp"`
}

// encodedFrame is one access unit, shared by reference with every viewer.
type encodedFrame struct {
	data []byte
	// rtpTime is session-relative 90 kHz capture time, wrapping exactly like
	// an RTP timestamp.
	rtpTime  uint32
	keyframe bool
}

// peerSignaling tracks the answer/candidate handshake for one viewer.
type peerSignaling struct {
	mu                sync.Mutex
	answered          bool
	pendingCandidates []IceCandidate
}

type peer struct {
	connection *webrtc.PeerConnection
	frames     chan *encodedFrame
	// resync is set when this viewer's queue overflowed, so its writer restarts
	// cleanly at the next keyframe rather than emitting frames whose references
	// were dropped.
	resync        atomic.Bool
	droppedFrames atomic.Uint64
	directOnly    bool
	signaling     *peerSignaling
	cancel        context.CancelFunc
	done          chan struct{}
	slot          uint8
}

// Hub owns one capture's WebRTC senders.
type Hub struct {
	sessionID string
	api       *webrtc.API
	codec     webrtc.RTPCodecCapability

	paceBitsPerSecond float64

	mu    sync.Mutex
	peers map[string]*peer
	slots uint8

	idrRequested atomic.Bool
	closed       atomic.Bool

	accessUnits   atomic.Uint64
	keyframes     atomic.Uint64
	encodedBytes  atomic.Uint64
	droppedFrames atomic.Uint64

	setsMu        sync.Mutex
	parameterSets parameterSets

	clockMu sync.Mutex
	clock   *captureClock
}

// h264Codec builds the codec capability, whose fmtp announces exactly the
// profile and level the encoder is configured for.
func h264Codec(profile h264.Profile, width, height, fps, bitrateMbps uint32) (webrtc.RTPCodecCapability, error) {
	profileLevelID, err := h264.ProfileLevelID(profile, width, height, fps, bitrateMbps)
	if err != nil {
		return webrtc.RTPCodecCapability{}, err
	}
	return webrtc.RTPCodecCapability{
		MimeType:  webrtc.MimeTypeH264,
		ClockRate: RTPClockRate,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" +
			profileLevelID,
		// Exactly the feedback this sender implements. Advertising transport-wide
		// congestion control without an estimator that drives the encoder's
		// bitrate only invites empty reports.
		RTCPFeedback: []webrtc.RTCPFeedback{
			{Type: "nack"},
			{Type: "nack", Parameter: "pli"},
			{Type: "ccm", Parameter: "fir"},
		},
	}, nil
}

// NewHub creates the sender for one capture.
func NewHub(sessionID string, profile h264.Profile, width, height, fps, bitrateMbps uint32) (*Hub, error) {
	if err := validateIdentifier("session ID", sessionID); err != nil {
		return nil, err
	}
	if fps == 0 {
		return nil, errors.New("native screen frame rate must be positive")
	}
	codec, err := h264Codec(profile, width, height, fps, bitrateMbps)
	if err != nil {
		return nil, err
	}

	media := &webrtc.MediaEngine{}
	// Interceptors are registered first so their own feedback registration
	// stays away from this codec, and the offer advertises exactly the
	// feedback above.
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(media, registry); err != nil {
		return nil, publicError(err)
	}
	if err := media.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: codec,
		PayloadType:        102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, publicError(err)
	}

	return &Hub{
		sessionID:         sessionID,
		api:               webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry)),
		codec:             codec,
		paceBitsPerSecond: float64(bitrateMbps) * 1_000_000 * PaceHeadroom,
		peers:             map[string]*peer{},
		clock:             newCaptureClock(fps),
	}, nil
}

// SessionID is the capture this hub belongs to.
func (h *Hub) SessionID() string { return h.sessionID }

// PeerCount is how many viewers are attached.
func (h *Hub) PeerCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.peers)
}

// TakeIDRRequest reports and clears a pending keyframe request.
//
// The encoder subprocess has no PLI channel, so a viewer's request is answered
// by restarting capture. Taking the flag rather than reading it keeps one
// request from causing repeated restarts.
func (h *Hub) TakeIDRRequest() bool { return h.idrRequested.Swap(false) }

// Stats is what the capture has produced so far.
type Stats struct {
	AccessUnits   uint64 `json:"accessUnits"`
	Keyframes     uint64 `json:"keyframes"`
	EncodedBytes  uint64 `json:"encodedBytes"`
	DroppedFrames uint64 `json:"droppedFrames"`
	Peers         int    `json:"peers"`
	// SPSProfileIDC and friends describe the stream the encoder actually
	// produced, which is what proves it honoured the profile it was given.
	SPSProfileIDC      string `json:"spsProfileIdc,omitempty"`
	SPSConstraintFlags string `json:"spsConstraintFlags,omitempty"`
	SPSLevelIDC        string `json:"spsLevelIdc,omitempty"`
}

// Stats reports the capture's counters and the parameter sets it has seen.
func (h *Hub) Stats() Stats {
	stats := Stats{
		AccessUnits:   h.accessUnits.Load(),
		Keyframes:     h.keyframes.Load(),
		EncodedBytes:  h.encodedBytes.Load(),
		DroppedFrames: h.droppedFrames.Load(),
		Peers:         h.PeerCount(),
	}
	h.setsMu.Lock()
	descriptor, ok := h.parameterSets.spsDescriptor()
	h.setsMu.Unlock()
	if ok {
		stats.SPSProfileIDC = fmt.Sprintf("%02x", descriptor[0])
		stats.SPSConstraintFlags = fmt.Sprintf("%02x", descriptor[1])
		stats.SPSLevelIDC = fmt.Sprintf("%02x", descriptor[2])
	}
	return stats
}

// prepareICEServers applies the direct-only choice to the supplied servers.
func prepareICEServers(servers []IceServer, directOnly bool) []webrtc.ICEServer {
	var prepared []webrtc.ICEServer
	for _, server := range servers {
		var urls []string
		for _, url := range server.URLs {
			lower := strings.ToLower(url)
			// Direct-only keeps media off a third-party relay, so a TURN server
			// is not merely deprioritised, it is not configured at all.
			if directOnly && (strings.HasPrefix(lower, "turn:") || strings.HasPrefix(lower, "turns:")) {
				continue
			}
			urls = append(urls, url)
		}
		if len(urls) == 0 {
			continue
		}
		prepared = append(prepared, webrtc.ICEServer{
			URLs:       urls,
			Username:   server.Username,
			Credential: server.Credential,
		})
	}
	return prepared
}

// CreatePeer offers video to one viewer.
//
// The offer is produced after ICE gathering completes, so the page relays one
// complete description rather than trickling from this side. TURN credentials
// stay inside the peer connection and are never returned or logged.
func (h *Hub) CreatePeer(ctx context.Context, peerID string, iceServers []IceServer, directOnly bool) (Offer, error) {
	if err := validateIdentifier("peer ID", peerID); err != nil {
		return Offer{}, err
	}
	if h.closed.Load() {
		return Offer{}, errors.New("native screen WebRTC hub is closed")
	}

	h.mu.Lock()
	if _, exists := h.peers[peerID]; exists {
		h.mu.Unlock()
		return Offer{}, errors.New("native screen peer already exists")
	}
	if len(h.peers) >= MaxPeers {
		h.mu.Unlock()
		return Offer{}, fmt.Errorf("native screen peer limit (%d) reached", MaxPeers)
	}
	h.slots++
	slot := h.slots
	// Reserve the name now so two concurrent creates cannot both pass the
	// checks above.
	h.peers[peerID] = nil
	h.mu.Unlock()

	release := func() {
		h.mu.Lock()
		if current, ok := h.peers[peerID]; ok && current == nil {
			delete(h.peers, peerID)
		}
		h.mu.Unlock()
	}

	connection, err := h.api.NewPeerConnection(webrtc.Configuration{
		ICEServers: prepareICEServers(iceServers, directOnly),
	})
	if err != nil {
		release()
		return Offer{}, publicError(err)
	}

	// Each viewer gets its own track, queue and writer. A shared track
	// serialises every packet write across all viewers, so one congested
	// viewer would otherwise stall the encoder pipe for everybody.
	track, err := webrtc.NewTrackLocalStaticRTP(
		h.codec,
		"native-screen-video-"+h.sessionID,
		"native-screen-"+h.sessionID,
	)
	if err != nil {
		_ = connection.Close()
		release()
		return Offer{}, publicError(err)
	}
	sender, err := connection.AddTrack(track)
	if err != nil {
		_ = connection.Close()
		release()
		return Offer{}, publicError(err)
	}

	offer, err := connection.CreateOffer(nil)
	if err != nil {
		_ = connection.Close()
		release()
		return Offer{}, publicError(err)
	}
	gathering := webrtc.GatheringCompletePromise(connection)
	if err := connection.SetLocalDescription(offer); err != nil {
		_ = connection.Close()
		release()
		return Offer{}, publicError(err)
	}

	gatherCtx, cancelGather := context.WithTimeout(ctx, iceGatherTimeout)
	defer cancelGather()
	select {
	case <-gathering:
	case <-gatherCtx.Done():
		_ = connection.Close()
		release()
		return Offer{}, errors.New("native screen ICE gathering timed out")
	}

	local := connection.LocalDescription()
	if local == nil {
		_ = connection.Close()
		release()
		return Offer{}, errors.New("native screen offer was not produced")
	}
	sdp := local.SDP
	if directOnly {
		sdp = withoutRelayCandidates(sdp)
	}

	peerCtx, cancel := context.WithCancel(context.Background())
	attached := &peer{
		connection: connection,
		frames:     make(chan *encodedFrame, peerQueueFrames),
		directOnly: directOnly,
		signaling:  &peerSignaling{},
		cancel:     cancel,
		done:       make(chan struct{}),
		slot:       slot,
	}

	h.mu.Lock()
	h.peers[peerID] = attached
	h.mu.Unlock()

	go h.readRTCP(peerCtx, sender)
	go h.writeFrames(peerCtx, attached, track)

	return Offer{PeerID: peerID, SDP: sdp}, nil
}

// readRTCP watches for keyframe requests. The encoder subprocess cannot be sent
// a PLI, so a request is recorded and answered by restarting capture.
func (h *Hub) readRTCP(ctx context.Context, sender *webrtc.RTPSender) {
	buffer := make([]byte, 1500)
	for {
		if ctx.Err() != nil {
			return
		}
		count, _, err := sender.Read(buffer)
		if err != nil {
			return
		}
		packets, err := rtcp.Unmarshal(buffer[:count])
		if err != nil {
			continue
		}
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				h.idrRequested.Store(true)
			}
		}
	}
}

// writeFrames drains one viewer's queue, packetising and pacing onto its track.
func (h *Hub) writeFrames(ctx context.Context, attached *peer, track *webrtc.TrackLocalStaticRTP) {
	defer close(attached.done)

	// The payload type and SSRC here are placeholders: the track rewrites both
	// per binding when the packet is actually sent.
	packetizer := rtp.NewPacketizer(
		RTPMTU,
		0,
		0,
		&codecs.H264Payloader{},
		rtp.NewRandomSequencer(),
		RTPClockRate,
	)
	paced := newPacer(h.paceBitsPerSecond)
	var waitingForKeyframe bool

	for {
		select {
		case <-ctx.Done():
			return
		case frame, ok := <-attached.frames:
			if !ok {
				return
			}
			// After an overflow the reference chain is broken. Resume at the
			// next keyframe rather than sending frames whose references were
			// dropped, which a decoder renders as smearing.
			if attached.resync.Swap(false) {
				waitingForKeyframe = true
			}
			if waitingForKeyframe {
				if !frame.keyframe {
					continue
				}
				waitingForKeyframe = false
			}

			// Samples are timestamped by the capture clock, so the packetizer
			// is given the frame's own duration of zero and the stamp is set
			// directly.
			packets := packetizer.Packetize(frame.data, 0)
			for _, packet := range packets {
				packet.Timestamp = frame.rtpTime
				bits := float64(len(packet.Payload)+RTPWireOverhead) * 8
				if err := paced.consume(ctx, bits); err != nil {
					return
				}
				if err := track.WriteRTP(packet); err != nil {
					// The viewer went away; its queue and this writer end with it.
					return
				}
			}
		}
	}
}

// ApplyAnswer accepts a viewer's answer and flushes any candidates that
// arrived before it.
func (h *Hub) ApplyAnswer(peerID, sdp string) error {
	attached, err := h.peer(peerID)
	if err != nil {
		return err
	}
	if err := attached.connection.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	}); err != nil {
		return publicError(err)
	}

	attached.signaling.mu.Lock()
	attached.signaling.answered = true
	pending := attached.signaling.pendingCandidates
	attached.signaling.pendingCandidates = nil
	attached.signaling.mu.Unlock()

	for _, candidate := range pending {
		if err := attached.connection.AddICECandidate(candidate.toInit()); err != nil {
			return publicError(err)
		}
	}
	return nil
}

// AddCandidate trickles one candidate in, queueing it when the answer has not
// arrived yet.
func (h *Hub) AddCandidate(peerID string, candidate IceCandidate) error {
	attached, err := h.peer(peerID)
	if err != nil {
		return err
	}
	// Direct-only refuses a relay candidate from the other side too. Accepting
	// one would put media on a relay the person asked to avoid.
	if attached.directOnly && isRelayCandidate(candidate.Candidate) {
		return nil
	}

	attached.signaling.mu.Lock()
	if !attached.signaling.answered {
		// A candidate before the answer has nowhere to go; hold it rather than
		// discarding a path that may be the only one that works.
		attached.signaling.pendingCandidates = append(attached.signaling.pendingCandidates, candidate)
		attached.signaling.mu.Unlock()
		return nil
	}
	attached.signaling.mu.Unlock()

	if err := attached.connection.AddICECandidate(candidate.toInit()); err != nil {
		return publicError(err)
	}
	return nil
}

func (c IceCandidate) toInit() webrtc.ICECandidateInit {
	return webrtc.ICECandidateInit{
		Candidate:     c.Candidate,
		SDPMid:        c.SDPMid,
		SDPMLineIndex: c.SDPMLineIndex,
	}
}

// RemovePeer detaches one viewer.
func (h *Hub) RemovePeer(peerID string) error {
	h.mu.Lock()
	attached, ok := h.peers[peerID]
	delete(h.peers, peerID)
	h.mu.Unlock()
	if !ok || attached == nil {
		return nil
	}
	attached.cancel()
	<-attached.done
	return attached.connection.Close()
}

// Close detaches every viewer and stops accepting new ones.
func (h *Hub) Close() {
	h.closed.Store(true)
	h.mu.Lock()
	attached := make([]*peer, 0, len(h.peers))
	for _, value := range h.peers {
		if value != nil {
			attached = append(attached, value)
		}
	}
	h.peers = map[string]*peer{}
	h.mu.Unlock()

	for _, value := range attached {
		value.cancel()
		<-value.done
		_ = value.connection.Close()
	}
}

func (h *Hub) peer(peerID string) (*peer, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	attached, ok := h.peers[peerID]
	if !ok || attached == nil {
		return nil, errors.New("native screen peer is unknown")
	}
	return attached, nil
}

// WriteAccessUnit fans one encoded access unit out to every viewer.
//
// A viewer whose queue is full drops the frame and is marked for resync. That
// is deliberate: blocking here would let one congested viewer stall the encoder
// pipe, which stalls capture for everybody including the local preview.
func (h *Hub) WriteAccessUnit(annexB []byte, arrivedAt time.Time) error {
	if h.closed.Load() {
		return errors.New("native screen WebRTC hub is closed")
	}
	if len(annexB) > MaxAccessUnitBytes {
		return errors.New("native screen H.264 access unit exceeded its size")
	}
	if !hasAnnexBStartCode(annexB) {
		return errors.New("native screen encoder produced a non-Annex B unit")
	}

	h.setsMu.Lock()
	prepared, err := prepareAccessUnit(annexB, &h.parameterSets)
	h.setsMu.Unlock()
	if err != nil {
		return err
	}

	h.clockMu.Lock()
	rtpTime := h.clock.advance(arrivedAt)
	h.clockMu.Unlock()

	keyframe := annexBHasIDR(prepared)
	h.accessUnits.Add(1)
	h.encodedBytes.Add(uint64(len(prepared)))
	if keyframe {
		h.keyframes.Add(1)
	}

	frame := &encodedFrame{data: prepared, rtpTime: rtpTime, keyframe: keyframe}

	h.mu.Lock()
	targets := make([]*peer, 0, len(h.peers))
	for _, value := range h.peers {
		if value != nil {
			targets = append(targets, value)
		}
	}
	h.mu.Unlock()

	for _, target := range targets {
		select {
		case target.frames <- frame:
		default:
			target.droppedFrames.Add(1)
			h.droppedFrames.Add(1)
			target.resync.Store(true)
		}
	}
	return nil
}
