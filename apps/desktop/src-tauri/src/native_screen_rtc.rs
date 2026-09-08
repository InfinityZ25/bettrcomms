//! Native H.264 WebRTC sender for the Windows screen-capture pipeline.
//!
//! This module deliberately has no Tauri commands. The application wrapper owns
//! authentication/signaling and passes only already-authorized peer IDs and ICE
//! configuration here. Encoded access units go directly to WebRTC packetization;
//! they never pass through Chromium's encoder.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as SyncMutex, MutexGuard,
    },
    time::{Duration, Instant},
};

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{mpsc, Mutex, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors,
        media_engine::{MediaEngine, MIME_TYPE_H264},
        APIBuilder, API,
    },
    ice_transport::{ice_candidate::RTCIceCandidateInit, ice_server::RTCIceServer},
    interceptor::registry::Registry,
    peer_connection::{
        configuration::RTCConfiguration, sdp::session_description::RTCSessionDescription,
        RTCPeerConnection,
    },
    rtcp::{
        compound_packet::CompoundPacket,
        packet::Packet,
        payload_feedbacks::{
            full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
        },
    },
    rtp::{
        codecs::h264::H264Payloader,
        packetizer::{new_packetizer, Packetizer},
        sequence::new_random_sequencer,
    },
    rtp_transceiver::{
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
        RTCPFeedback,
    },
    stats::StatsReportType,
    track::track_local::{
        track_local_static_rtp::TrackLocalStaticRTP, TrackLocal, TrackLocalWriter,
    },
};

const MAX_PEERS: usize = 8;
const MAX_ACCESS_UNIT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PARAMETER_SET_BYTES: usize = 64 * 1024;
const ICE_GATHER_TIMEOUT: Duration = Duration::from_secs(15);
const RTP_CLOCK_RATE: u32 = 90_000;
/// Keeps an RTP packet plus its SRTP tag and UDP/IP headers inside a 1280-byte
/// path MTU, which is the smallest an IPv6 route is allowed to offer.
const RTP_MTU: usize = 1200;
/// Bytes of transport overhead a paced RTP packet actually costs on the wire.
const RTP_WIRE_OVERHEAD: usize = 38;
/// Per-viewer send queue. Deep enough to absorb ordinary scheduling jitter and
/// shallow enough that a stalled viewer cannot accumulate seconds of stale video.
const PEER_QUEUE_FRAMES: usize = 16;
/// Keyframes are paced above the target rate, the way libwebrtc's pacer does,
/// so an access unit spreads over milliseconds instead of arriving as one burst.
const PACE_HEADROOM: f64 = 2.5;
const PACE_BURST: Duration = Duration::from_millis(5);
/// One capture gap never advances the RTP clock by more than this.
const MAX_FRAME_GAP_TICKS: f64 = 10.0 * RTP_CLOCK_RATE as f64;
/// The sender's own preview connection. It never leaves the machine, so there
/// is no path capacity to pace against and pacing would only add latency.
const PREVIEW_PEER_ID: &str = "__preview";

fn lock<T>(mutex: &SyncMutex<T>) -> MutexGuard<'_, T> {
    // Capture state is plain data; a panicking writer must not stop the stream.
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeH264Profile {
    Baseline,
    Main,
    High,
}

impl NativeH264Profile {
    pub fn ffmpeg_name(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::Main => "main",
            Self::High => "high",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIceServer {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_mline_index: Option<u16>,
    pub username_fragment: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOffer {
    pub peer_id: String,
    pub sdp: String,
}

/// One encoded access unit, shared by reference with every viewer's queue.
struct EncodedFrame {
    data: Bytes,
    /// Session-relative 90 kHz capture time, wrapping exactly like an RTP stamp.
    rtp_time: u32,
    keyframe: bool,
}

struct NativePeer {
    connection: Arc<RTCPeerConnection>,
    rtcp_task: JoinHandle<()>,
    writer_task: JoinHandle<()>,
    frames: mpsc::Sender<Arc<EncodedFrame>>,
    /// Set when this viewer's queue overflowed, so its writer restarts cleanly
    /// at the next keyframe instead of emitting frames with missing references.
    resync: Arc<AtomicBool>,
    dropped_frames: Arc<AtomicU64>,
    direct_only: bool,
    signaling: Arc<Mutex<NativePeerSignaling>>,
    _permit: OwnedSemaphorePermit,
}

#[derive(Default)]
struct NativePeerSignaling {
    answered: bool,
    pending_candidates: Vec<NativeIceCandidate>,
}

pub struct NativeScreenRtcHub {
    session_id: String,
    api: Arc<API>,
    codec: RTCRtpCodecCapability,
    pace_bits_per_second: f64,
    peers: SyncMutex<HashMap<String, NativePeer>>,
    peer_slots: Arc<Semaphore>,
    idr_requested: Arc<AtomicBool>,
    access_units: AtomicU64,
    keyframes: AtomicU64,
    encoded_bytes: AtomicU64,
    dropped_frames: AtomicU64,
    parameter_sets: SyncMutex<ParameterSets>,
    clock: SyncMutex<CaptureClock>,
    closed: AtomicBool,
}

impl NativeScreenRtcHub {
    pub fn new(
        session_id: String,
        profile: NativeH264Profile,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_mbps: u32,
    ) -> Result<Arc<Self>, String> {
        validate_identifier("session ID", &session_id)?;
        if fps == 0 {
            return Err("native screen frame rate must be positive".to_owned());
        }
        let codec = h264_codec(profile, width, height, fps, bitrate_mbps)?;
        let mut media_engine = MediaEngine::default();
        // Registering the interceptors first keeps their feedback registration
        // away from this codec, so the offer advertises exactly the feedback
        // this sender implements: NACK retransmission, PLI and FIR. Transport-wide
        // congestion control belongs here once an estimator actually drives the
        // encoder's bitrate; advertising it without one only invites empty reports.
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)
            .map_err(public_error)?;
        media_engine
            .register_codec(
                RTCRtpCodecParameters {
                    capability: codec.clone(),
                    payload_type: 125,
                    ..Default::default()
                },
                RTPCodecType::Video,
            )
            .map_err(public_error)?;
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();
        Ok(Arc::new(Self {
            session_id,
            api: Arc::new(api),
            codec,
            pace_bits_per_second: bitrate_mbps as f64 * 1_000_000.0 * PACE_HEADROOM,
            peers: SyncMutex::new(HashMap::new()),
            peer_slots: Arc::new(Semaphore::new(MAX_PEERS)),
            idr_requested: Arc::new(AtomicBool::new(false)),
            access_units: AtomicU64::new(0),
            keyframes: AtomicU64::new(0),
            encoded_bytes: AtomicU64::new(0),
            dropped_frames: AtomicU64::new(0),
            parameter_sets: SyncMutex::new(ParameterSets::default()),
            clock: SyncMutex::new(CaptureClock::new(fps)),
            closed: AtomicBool::new(false),
        }))
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Creates a video-only offer after ICE gathering completes. TURN credentials
    /// are held inside the peer connection and are never returned or logged.
    pub async fn create_peer(
        self: &Arc<Self>,
        peer_id: String,
        ice_servers: Vec<NativeIceServer>,
        direct_only: bool,
    ) -> Result<NativeOffer, String> {
        validate_identifier("peer ID", &peer_id)?;
        if self.closed.load(Ordering::Acquire) {
            return Err("native screen WebRTC hub is closed".to_owned());
        }
        if lock(&self.peers).contains_key(&peer_id) {
            return Err("native screen peer already exists".to_owned());
        }
        let permit = Arc::clone(&self.peer_slots)
            .try_acquire_owned()
            .map_err(|_| format!("native screen peer limit ({MAX_PEERS}) reached"))?;
        let configured_servers = prepare_ice_servers(ice_servers, direct_only)?;
        let connection = Arc::new(
            self.api
                .new_peer_connection(RTCConfiguration {
                    ice_servers: configured_servers,
                    ..Default::default()
                })
                .await
                .map_err(public_error)?,
        );
        // Each viewer gets its own track, queue and writer task. A shared track
        // serializes every packet write across all viewers, so one congested
        // viewer would otherwise stall the encoder pipe for everybody.
        let track = Arc::new(TrackLocalStaticRTP::new(
            self.codec.clone(),
            format!("native-screen-video-{}", self.session_id),
            format!("native-screen-{}", self.session_id),
        ));
        let sender = match connection
            .add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
        {
            Ok(sender) => sender,
            Err(error) => {
                let _ = connection.close().await;
                return Err(public_error(error));
            }
        };
        let offer = match connection.create_offer(None).await {
            Ok(offer) => offer,
            Err(error) => {
                let _ = connection.close().await;
                return Err(public_error(error));
            }
        };
        let mut gathering = connection.gathering_complete_promise().await;
        if let Err(error) = connection.set_local_description(offer).await {
            let _ = connection.close().await;
            return Err(public_error(error));
        }
        if tokio::time::timeout(ICE_GATHER_TIMEOUT, gathering.recv())
            .await
            .is_err()
        {
            let _ = connection.close().await;
            return Err("native screen ICE gathering timed out".to_owned());
        }
        let local = match connection.local_description().await {
            Some(local) => local,
            None => {
                let _ = connection.close().await;
                return Err("native screen peer produced no local description".to_owned());
            }
        };
        let sdp = if direct_only {
            without_relay_candidates(&local.sdp)
        } else {
            local.sdp
        };
        let idr_requested = Arc::clone(&self.idr_requested);
        let rtcp_task = tokio::spawn(async move {
            while let Ok((packets, _)) = sender.read_rtcp().await {
                if packets
                    .iter()
                    .any(|packet| requests_keyframe(packet.as_ref()))
                {
                    idr_requested.store(true, Ordering::Release);
                }
            }
        });
        let resync = Arc::new(AtomicBool::new(false));
        let dropped_frames = Arc::new(AtomicU64::new(0));
        let (frames, receiver) = mpsc::channel(PEER_QUEUE_FRAMES);
        let writer_task = spawn_peer_writer(
            track,
            receiver,
            Arc::clone(&resync),
            if peer_id == PREVIEW_PEER_ID {
                None
            } else {
                Some(self.pace_bits_per_second)
            },
        );
        // Scope the synchronous peer lock so it is never held across an await.
        let rejection = {
            let mut peers = lock(&self.peers);
            let rejection = if self.closed.load(Ordering::Acquire) {
                Some("native screen WebRTC hub is closed".to_owned())
            } else if peers.contains_key(&peer_id) {
                Some("native screen peer already exists".to_owned())
            } else {
                None
            };
            if let Some(rejection) = rejection {
                rtcp_task.abort();
                writer_task.abort();
                Some(rejection)
            } else {
                peers.insert(
                    peer_id.clone(),
                    NativePeer {
                        connection: Arc::clone(&connection),
                        rtcp_task,
                        writer_task,
                        frames,
                        resync,
                        dropped_frames,
                        direct_only,
                        signaling: Arc::new(Mutex::new(NativePeerSignaling::default())),
                        _permit: permit,
                    },
                );
                None
            }
        };
        if let Some(rejection) = rejection {
            let _ = connection.close().await;
            return Err(rejection);
        }
        Ok(NativeOffer { peer_id, sdp })
    }

    pub async fn set_answer(&self, peer_id: &str, sdp: String) -> Result<(), String> {
        let (connection, direct_only, signaling) = self.peer(peer_id).await?;
        let mut signaling = signaling.lock().await;
        let sdp = if direct_only {
            without_relay_candidates(&sdp)
        } else {
            sdp
        };
        connection
            .set_remote_description(RTCSessionDescription::answer(sdp).map_err(public_error)?)
            .await
            .map_err(public_error)?;
        signaling.answered = true;
        for candidate in std::mem::take(&mut signaling.pending_candidates) {
            connection
                .add_ice_candidate(candidate.into())
                .await
                .map_err(public_error)?;
        }
        Ok(())
    }

    pub async fn add_candidate(
        &self,
        peer_id: &str,
        candidate: NativeIceCandidate,
    ) -> Result<(), String> {
        let (connection, direct_only, signaling) = self.peer(peer_id).await?;
        if direct_only && is_relay_candidate(&candidate.candidate) {
            return Err("relay ICE candidates are disabled for this peer".to_owned());
        }
        let mut signaling = signaling.lock().await;
        if !signaling.answered {
            if signaling.pending_candidates.len() >= 256 {
                return Err("too many pending native screen ICE candidates".to_owned());
            }
            signaling.pending_candidates.push(candidate);
            return Ok(());
        }
        connection
            .add_ice_candidate(candidate.into())
            .await
            .map_err(public_error)
    }

    pub async fn remove_peer(&self, peer_id: &str) -> Result<(), String> {
        let peer = lock(&self.peers)
            .remove(peer_id)
            .ok_or_else(|| "native screen peer was not found".to_owned())?;
        peer.rtcp_task.abort();
        peer.writer_task.abort();
        peer.connection.close().await.map_err(public_error)
    }

    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.peer_slots.close();
        let peers = std::mem::take(&mut *lock(&self.peers));
        for (_, peer) in peers {
            peer.rtcp_task.abort();
            peer.writer_task.abort();
            let _ = peer.connection.close().await;
        }
    }

    /// Queues one complete Annex-B H.264 access unit for every bound peer.
    ///
    /// This runs on the encoder's output thread and never awaits the network:
    /// each viewer owns a bounded queue drained by its own paced writer task.
    /// `arrived_at` is when the encoder finished the access unit; the RTP clock
    /// is derived from it rather than from a nominal frame interval.
    pub fn write_access_unit(&self, annex_b: Vec<u8>, arrived_at: Instant) -> Result<(), String> {
        if annex_b.is_empty() || annex_b.len() > MAX_ACCESS_UNIT_BYTES {
            return Err("native screen H.264 access unit has an invalid size".to_owned());
        }
        if !has_annex_b_start_code(&annex_b) {
            return Err("native screen H.264 access unit is not Annex-B".to_owned());
        }
        let annex_b = prepare_access_unit(annex_b, &mut lock(&self.parameter_sets))?;
        let keyframe = annex_b_has_idr(&annex_b);
        self.access_units.fetch_add(1, Ordering::Relaxed);
        self.encoded_bytes
            .fetch_add(annex_b.len() as u64, Ordering::Relaxed);
        if keyframe {
            self.keyframes.fetch_add(1, Ordering::Relaxed);
        }
        let frame = Arc::new(EncodedFrame {
            data: Bytes::from(annex_b),
            rtp_time: lock(&self.clock).advance(arrived_at),
            keyframe,
        });
        for peer in lock(&self.peers).values() {
            if peer.frames.try_send(Arc::clone(&frame)).is_err() {
                // This viewer cannot keep up. Drop its frame rather than block
                // the encoder, and make its writer resume at the next keyframe.
                peer.resync.store(true, Ordering::Release);
                peer.dropped_frames.fetch_add(1, Ordering::Relaxed);
                self.dropped_frames.fetch_add(1, Ordering::Relaxed);
            }
        }
        Ok(())
    }

    /// Returns and clears the coalesced PLI/FIR request. The encoder should force
    /// its next access unit to IDR. A one-second periodic IDR remains mandatory.
    pub fn take_idr_request(&self) -> bool {
        self.idr_requested.swap(false, Ordering::AcqRel)
    }

    pub fn peer_count(&self) -> usize {
        lock(&self.peers).len()
    }

    pub async fn diagnostics(&self) -> NativeRtcDiagnostics {
        let sps = lock(&self.parameter_sets).sps_descriptor();
        // Snapshot before awaiting: the peer map is a synchronous lock so the
        // encoder thread can enqueue frames without waiting on the async runtime.
        let mut ordered = {
            let peers = lock(&self.peers);
            let mut rows = peers
                .iter()
                .map(|(peer_id, peer)| {
                    (
                        peer_id.clone(),
                        Arc::clone(&peer.connection),
                        peer.direct_only,
                        Arc::clone(&peer.signaling),
                        peer.dropped_frames.load(Ordering::Relaxed),
                    )
                })
                .collect::<Vec<_>>();
            rows.sort_by(|left, right| left.0.cmp(&right.0));
            rows
        };
        let mut peer_diagnostics = Vec::with_capacity(ordered.len());
        for (index, (peer_id, connection, direct_only, signaling, dropped_frames)) in
            ordered.drain(..).enumerate()
        {
            let reports = connection.get_stats().await;
            let mut packets_sent = 0;
            let mut bytes_sent = 0;
            let mut nack_count = 0;
            let mut pli_count = 0;
            let mut fir_count = 0;
            let mut packets_received = 0;
            let mut packets_lost = 0;
            let mut round_trip_time_ms = None;
            for report in reports.reports.values() {
                match report {
                    StatsReportType::OutboundRTP(stats) if stats.kind == "video" => {
                        packets_sent += stats.packets_sent;
                        bytes_sent += stats.bytes_sent;
                        nack_count += stats.nack_count;
                        pli_count += stats.pli_count.unwrap_or_default();
                        fir_count += stats.fir_count.unwrap_or_default();
                    }
                    StatsReportType::RemoteInboundRTP(stats) if stats.kind == "video" => {
                        packets_received += stats.packets_received;
                        packets_lost += stats.packets_lost;
                        round_trip_time_ms = stats.round_trip_time.map(|value| value * 1_000.0);
                    }
                    _ => {}
                }
            }
            let signaling = signaling.lock().await;
            peer_diagnostics.push(NativePeerDiagnostics {
                slot: (index + 1) as u8,
                preview: peer_id.as_str() == PREVIEW_PEER_ID,
                connection_state: connection.connection_state().to_string(),
                ice_connection_state: connection.ice_connection_state().to_string(),
                signaling_state: connection.signaling_state().to_string(),
                answer_applied: signaling.answered,
                pending_candidates: signaling.pending_candidates.len(),
                direct_only,
                dropped_frames,
                packets_sent,
                bytes_sent,
                packets_received,
                packets_lost,
                nack_count,
                pli_count,
                fir_count,
                round_trip_time_ms,
            });
        }
        NativeRtcDiagnostics {
            access_units: self.access_units.load(Ordering::Relaxed),
            keyframes: self.keyframes.load(Ordering::Relaxed),
            encoded_bytes: self.encoded_bytes.load(Ordering::Relaxed),
            dropped_frames: self.dropped_frames.load(Ordering::Relaxed),
            pace_bits_per_second: self.pace_bits_per_second as u64,
            sps_profile_idc: sps.map(|value| format!("{:02x}", value[0])),
            sps_constraint_flags: sps.map(|value| format!("{:02x}", value[1])),
            sps_level_idc: sps.map(|value| format!("{:02x}", value[2])),
            peers: peer_diagnostics,
        }
    }

    async fn peer(
        &self,
        peer_id: &str,
    ) -> Result<
        (
            Arc<RTCPeerConnection>,
            bool,
            Arc<Mutex<NativePeerSignaling>>,
        ),
        String,
    > {
        lock(&self.peers)
            .get(peer_id)
            .map(|peer| {
                (
                    Arc::clone(&peer.connection),
                    peer.direct_only,
                    Arc::clone(&peer.signaling),
                )
            })
            .ok_or_else(|| "native screen peer was not found".to_owned())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRtcDiagnostics {
    pub access_units: u64,
    pub keyframes: u64,
    pub encoded_bytes: u64,
    /// Frames dropped because a viewer's own queue overflowed. Non-zero here
    /// means a specific viewer could not keep up, not that capture stalled.
    pub dropped_frames: u64,
    pub pace_bits_per_second: u64,
    pub sps_profile_idc: Option<String>,
    pub sps_constraint_flags: Option<String>,
    pub sps_level_idc: Option<String>,
    pub peers: Vec<NativePeerDiagnostics>,
}

#[derive(Default)]
struct ParameterSets {
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
}

impl ParameterSets {
    fn sps_descriptor(&self) -> Option<[u8; 3]> {
        let unit = self.sps.as_deref()?;
        let header = nal_header_offset(unit)?;
        Some([
            *unit.get(header + 1)?,
            *unit.get(header + 2)?,
            *unit.get(header + 3)?,
        ])
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePeerDiagnostics {
    slot: u8,
    preview: bool,
    connection_state: String,
    ice_connection_state: String,
    signaling_state: String,
    answer_applied: bool,
    pending_candidates: usize,
    direct_only: bool,
    dropped_frames: u64,
    packets_sent: u64,
    bytes_sent: u64,
    packets_received: u64,
    packets_lost: i64,
    nack_count: u64,
    pli_count: u64,
    fir_count: u64,
    round_trip_time_ms: Option<f64>,
}

/// Turns encoder output instants into RTP timestamps.
///
/// FFmpeg emits constant-rate frames and several can land in one pipe read, so
/// spacing follows the nominal interval. When capture genuinely falls behind,
/// the clock resynchronizes to the arrival instant instead of drifting away
/// from wall time the way a fixed `1/fps` step per access unit does.
struct CaptureClock {
    frame_interval: Duration,
    /// The nominal interval in exact 90 kHz ticks. Stepping the grid by this
    /// rather than by a nanosecond-truncated `Duration` keeps the common case
    /// free of the rounding error a per-frame conversion would accumulate.
    frame_ticks: f64,
    resync_after: Duration,
    cursor: Option<Instant>,
    ticks: f64,
}

impl CaptureClock {
    fn new(fps: u32) -> Self {
        let fps = fps.max(1);
        let frame_interval = Duration::from_secs_f64(1.0 / fps as f64);
        Self {
            frame_interval,
            frame_ticks: RTP_CLOCK_RATE as f64 / fps as f64,
            resync_after: (frame_interval * 3).max(Duration::from_millis(25)),
            cursor: None,
            ticks: 0.0,
        }
    }

    fn advance(&mut self, arrived_at: Instant) -> u32 {
        if let Some(cursor) = self.cursor {
            let nominal = cursor + self.frame_interval;
            if arrived_at > nominal + self.resync_after {
                let elapsed = arrived_at.saturating_duration_since(cursor).as_secs_f64();
                self.ticks += (elapsed * RTP_CLOCK_RATE as f64).min(MAX_FRAME_GAP_TICKS);
                self.cursor = Some(arrived_at);
            } else {
                self.ticks += self.frame_ticks;
                self.cursor = Some(nominal);
            }
        } else {
            self.cursor = Some(arrived_at);
        }
        self.ticks as u64 as u32
    }
}

/// Leaky bucket that spreads a large access unit over time instead of emitting
/// a two-second keyframe as one burst that shallow path buffers simply drop.
struct Pacer {
    rate_bits_per_second: f64,
    burst_bits: f64,
    tokens: f64,
    last: Instant,
}

impl Pacer {
    fn new(rate_bits_per_second: f64) -> Self {
        let rate_bits_per_second = rate_bits_per_second.max(1_000.0);
        // The bucket must hold at least a few whole packets or a single packet
        // could never be affordable and the writer would spin.
        let burst_bits = (rate_bits_per_second * PACE_BURST.as_secs_f64())
            .max(4.0 * (RTP_MTU + RTP_WIRE_OVERHEAD) as f64 * 8.0);
        Self {
            rate_bits_per_second,
            burst_bits,
            tokens: burst_bits,
            last: Instant::now(),
        }
    }

    async fn consume(&mut self, bits: f64) {
        let bits = bits.min(self.burst_bits);
        loop {
            let now = Instant::now();
            let refill =
                now.saturating_duration_since(self.last).as_secs_f64() * self.rate_bits_per_second;
            self.tokens = (self.tokens + refill).min(self.burst_bits);
            self.last = now;
            if self.tokens >= bits {
                self.tokens -= bits;
                return;
            }
            tokio::time::sleep(Duration::from_secs_f64(
                (bits - self.tokens) / self.rate_bits_per_second,
            ))
            .await;
        }
    }
}

/// Drains one viewer's queue, packetizing and pacing onto that viewer's track.
fn spawn_peer_writer(
    track: Arc<TrackLocalStaticRTP>,
    mut frames: mpsc::Receiver<Arc<EncodedFrame>>,
    resync: Arc<AtomicBool>,
    pace_bits_per_second: Option<f64>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        // The payload type and SSRC here are placeholders: the track rewrites
        // both per binding when the packet is actually sent.
        let mut packetizer = new_packetizer(
            RTP_MTU,
            0,
            0,
            Box::new(H264Payloader::default()),
            Box::new(new_random_sequencer()),
            RTP_CLOCK_RATE,
        );
        let mut pacer = pace_bits_per_second.map(Pacer::new);
        let mut previous: Option<u32> = None;
        // A viewer must start on a keyframe. Mid-GOP frames only feed the
        // decoder broken references while consuming that viewer's downlink.
        let mut awaiting_keyframe = true;
        while let Some(frame) = frames.recv().await {
            // Advance the packetizer's clock for every frame this writer saw,
            // including skipped ones, so timestamps stay tied to capture time.
            let delta = previous.map_or(0, |previous| frame.rtp_time.wrapping_sub(previous));
            previous = Some(frame.rtp_time);
            packetizer.skip_samples(delta);
            if resync.swap(false, Ordering::AcqRel) {
                awaiting_keyframe = true;
            }
            if awaiting_keyframe && !frame.keyframe {
                continue;
            }
            awaiting_keyframe = false;
            let Ok(packets) = packetizer.packetize(&frame.data, 0) else {
                awaiting_keyframe = true;
                continue;
            };
            for packet in &packets {
                if let Some(pacer) = pacer.as_mut() {
                    pacer
                        .consume((packet.payload.len() + RTP_WIRE_OVERHEAD) as f64 * 8.0)
                        .await;
                }
                // A closed or unbound track is an ordinary teardown race; the
                // task ends when the hub drops this viewer's queue sender.
                let _ = track.write_rtp(packet).await;
            }
        }
    })
}

impl From<NativeIceCandidate> for RTCIceCandidateInit {
    fn from(candidate: NativeIceCandidate) -> Self {
        Self {
            candidate: candidate.candidate,
            sdp_mid: candidate.sdp_mid,
            sdp_mline_index: candidate.sdp_mline_index,
            username_fragment: candidate.username_fragment,
        }
    }
}

fn h264_codec(
    profile: NativeH264Profile,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_mbps: u32,
) -> Result<RTCRtpCodecCapability, String> {
    let level = h264_level(profile, width, height, fps, bitrate_mbps)?;
    let profile_prefix = match profile {
        NativeH264Profile::Baseline => "42e0",
        NativeH264Profile::Main => "4d00",
        NativeH264Profile::High => "6400",
    };
    Ok(RTCRtpCodecCapability {
        mime_type: MIME_TYPE_H264.to_owned(),
        clock_rate: 90_000,
        channels: 0,
        sdp_fmtp_line: format!(
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id={profile_prefix}{:02x}",
            level.0
        ),
        rtcp_feedback: vec![
            RTCPFeedback { typ: "nack".to_owned(), parameter: String::new() },
            RTCPFeedback { typ: "nack".to_owned(), parameter: "pli".to_owned() },
            RTCPFeedback { typ: "ccm".to_owned(), parameter: "fir".to_owned() },
        ],
    })
}

/// Returns the FFmpeg `-level:v` value selected by the same Annex A limits used
/// in the advertised WebRTC `profile-level-id`.
pub fn h264_ffmpeg_level(
    profile: NativeH264Profile,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_mbps: u32,
) -> Result<&'static str, String> {
    Ok(h264_level(profile, width, height, fps, bitrate_mbps)?.1)
}

fn h264_level(
    profile: NativeH264Profile,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_mbps: u32,
) -> Result<(u8, &'static str), String> {
    let macroblocks = width
        .div_ceil(16)
        .checked_mul(height.div_ceil(16))
        .ok_or("Native screen dimensions overflow")?;
    let macroblocks_per_second = macroblocks
        .checked_mul(fps)
        .ok_or("Native screen frame rate overflows")?;
    let bitrate_kbps = bitrate_mbps
        .checked_mul(1_000)
        .ok_or("Native screen bitrate overflows")?;
    // Annex A limits: level_idc, MaxMBPS, MaxFS, baseline/main MaxBR (kbit/s).
    let levels = [
        (0x1f, "3.1", 108_000, 3_600, 14_000),
        (0x20, "3.2", 216_000, 5_120, 20_000),
        (0x28, "4.0", 245_760, 8_192, 20_000),
        (0x29, "4.1", 245_760, 8_192, 50_000),
        (0x2a, "4.2", 522_240, 8_704, 50_000),
        (0x32, "5.0", 589_824, 22_080, 135_000),
        (0x33, "5.1", 983_040, 36_864, 240_000),
        (0x34, "5.2", 2_073_600, 36_864, 240_000),
    ];
    levels
        .into_iter()
        .find(|(_, _, max_mbps, max_fs, baseline_max_br)| {
            let max_br = if profile == NativeH264Profile::High {
                baseline_max_br * 5 / 4
            } else {
                *baseline_max_br
            };
            macroblocks_per_second <= *max_mbps && macroblocks <= *max_fs && bitrate_kbps <= max_br
        })
        .map(|(level, name, _, _, _)| (level, name))
        .ok_or_else(|| "Native screen settings exceed H.264 level 5.2".to_owned())
}

fn prepare_ice_servers(
    servers: Vec<NativeIceServer>,
    direct_only: bool,
) -> Result<Vec<RTCIceServer>, String> {
    servers
        .into_iter()
        .filter_map(|server| {
            let urls: Vec<_> = server
                .urls
                .into_iter()
                .filter(|url| {
                    !direct_only
                        || !(url.to_ascii_lowercase().starts_with("turn:")
                            || url.to_ascii_lowercase().starts_with("turns:"))
                })
                .collect();
            if urls.is_empty() {
                None
            } else {
                Some(Ok(RTCIceServer {
                    urls,
                    username: server.username,
                    credential: server.credential,
                }))
            }
        })
        .collect()
}

fn requests_keyframe(packet: &(dyn Packet + Send + Sync)) -> bool {
    if packet.as_any().is::<PictureLossIndication>() || packet.as_any().is::<FullIntraRequest>() {
        return true;
    }
    packet
        .as_any()
        .downcast_ref::<CompoundPacket>()
        .is_some_and(|compound| {
            compound
                .0
                .iter()
                .any(|inner| requests_keyframe(inner.as_ref()))
        })
}

fn is_relay_candidate(candidate: &str) -> bool {
    candidate
        .to_ascii_lowercase()
        .split_ascii_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .any(|pair| pair == ["typ", "relay"])
}

fn without_relay_candidates(sdp: &str) -> String {
    let separator = if sdp.contains("\r\n") { "\r\n" } else { "\n" };
    let trailing = sdp.ends_with(separator);
    let mut filtered = sdp
        .split_terminator(separator)
        .filter(|line| !(line.starts_with("a=candidate:") && is_relay_candidate(line)))
        .collect::<Vec<_>>()
        .join(separator);
    if trailing {
        filtered.push_str(separator);
    }
    filtered
}

fn has_annex_b_start_code(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0, 0, 1]) || bytes.starts_with(&[0, 0, 0, 1])
}

fn nal_header_offset(unit: &[u8]) -> Option<usize> {
    if unit.starts_with(&[0, 0, 0, 1]) {
        Some(4)
    } else if unit.starts_with(&[0, 0, 1]) {
        Some(3)
    } else {
        None
    }
}

fn annex_b_units(bytes: &[u8]) -> Vec<(usize, usize, usize, u8)> {
    let mut starts = Vec::new();
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let length = if bytes[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if bytes[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };
        if index + length < bytes.len() {
            starts.push((index, index + length));
        }
        index += length;
    }
    starts
        .iter()
        .enumerate()
        .map(|(position, &(start, header))| {
            let end = starts.get(position + 1).map_or(bytes.len(), |next| next.0);
            (start, header, end, bytes[header] & 0x1f)
        })
        .collect()
}

fn prepare_access_unit(annex_b: Vec<u8>, cache: &mut ParameterSets) -> Result<Vec<u8>, String> {
    let units = annex_b_units(&annex_b);
    let has_sps = units.iter().any(|unit| unit.3 == 7);
    let has_pps = units.iter().any(|unit| unit.3 == 8);
    let has_idr = units.iter().any(|unit| unit.3 == 5);
    let incoming_sps = units
        .iter()
        .find(|unit| unit.3 == 7)
        .map(|unit| &annex_b[unit.1..unit.2]);
    let cached_sps = cache
        .sps
        .as_deref()
        .and_then(|unit| nal_header_offset(unit).map(|header| &unit[header..]));
    if has_sps && !has_pps && incoming_sps != cached_sps {
        // A changed SPS can invalidate the old PPS. Wait for its matching PPS
        // rather than attaching stale decoder configuration to an IDR.
        cache.pps = None;
    }
    for &(start, _, end, kind) in &units {
        if kind != 7 && kind != 8 {
            continue;
        }
        let length = end - start;
        if length > MAX_PARAMETER_SET_BYTES {
            return Err("native screen H.264 parameter set exceeded 64 KiB".to_owned());
        }
        let value = annex_b[start..end].to_vec();
        if kind == 7 {
            cache.sps = Some(value);
        } else {
            cache.pps = Some(value);
        }
    }
    if !has_idr || (has_sps && has_pps) {
        return Ok(annex_b);
    }
    let mut prefix = Vec::new();
    if !has_sps {
        if let Some(sps) = &cache.sps {
            prefix.extend_from_slice(sps);
        }
    }
    if !has_pps {
        if let Some(pps) = &cache.pps {
            prefix.extend_from_slice(pps);
        }
    }
    if prefix.is_empty() {
        return Ok(annex_b);
    }
    if prefix.len() + annex_b.len() > MAX_ACCESS_UNIT_BYTES {
        return Err(
            "native screen H.264 access unit exceeded its size after configuration".to_owned(),
        );
    }
    let insertion = units
        .iter()
        .find(|unit| {
            if !has_sps {
                unit.3 != 9
            } else {
                unit.3 == 8 || matches!(unit.3, 1..=5)
            }
        })
        .map_or(annex_b.len(), |unit| unit.0);
    let mut configured = Vec::with_capacity(prefix.len() + annex_b.len());
    configured.extend_from_slice(&annex_b[..insertion]);
    configured.extend_from_slice(&prefix);
    configured.extend_from_slice(&annex_b[insertion..]);
    Ok(configured)
}

fn annex_b_has_idr(bytes: &[u8]) -> bool {
    annex_b_units(bytes).iter().any(|unit| unit.3 == 5)
}

fn validate_identifier(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn public_error(error: impl std::fmt::Display) -> String {
    // Never include configuration objects or SDP here because they may contain TURN credentials.
    format!("native screen WebRTC operation failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_only_removes_relay_lines() {
        let sdp = "v=0\r\na=candidate:1 1 udp 1 10.0.0.1 1 typ host\r\na=candidate:2 1 udp 1 1.2.3.4 2 typ relay\r\n";
        let filtered = without_relay_candidates(sdp);
        assert!(filtered.contains("typ host"));
        assert!(!filtered.contains("typ relay"));
        assert!(filtered.ends_with("\r\n"));
    }

    #[test]
    fn annex_b_validation_is_bounded() {
        assert!(has_annex_b_start_code(&[0, 0, 0, 1, 0x65]));
        assert!(!has_annex_b_start_code(&[0, 0, 2, 1]));
        assert!(annex_b_has_idr(&[0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x65]));
        assert!(!annex_b_has_idr(&[0, 0, 1, 0x41, 1, 2, 3]));
    }

    #[test]
    fn parameter_sets_are_cached_and_precede_late_idr_after_aud() {
        let mut cache = ParameterSets::default();
        let configured = vec![
            0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xaa, 0, 0, 1, 0x68, 0xbb, 0, 0, 1, 0x65, 0xcc,
        ];
        assert_eq!(
            prepare_access_unit(configured.clone(), &mut cache).unwrap(),
            configured
        );
        assert_eq!(cache.sps_descriptor(), Some([0x42, 0xe0, 0x1f]));

        let late_idr = vec![0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x65, 0xdd];
        let prepared = prepare_access_unit(late_idr, &mut cache).unwrap();
        assert_eq!(
            prepared,
            vec![
                0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xaa, 0, 0, 1, 0x68, 0xbb,
                0, 0, 0, 1, 0x65, 0xdd,
            ]
        );

        let delta = vec![0, 0, 1, 0x41, 1, 2, 3];
        assert_eq!(
            prepare_access_unit(delta.clone(), &mut cache).unwrap(),
            delta
        );
    }

    #[test]
    fn changed_sps_does_not_reuse_an_old_pps() {
        let mut cache = ParameterSets {
            sps: Some(vec![0, 0, 1, 0x67, 0x42, 0xe0, 0x1f]),
            pps: Some(vec![0, 0, 1, 0x68, 1]),
        };
        let changed = vec![0, 0, 1, 0x67, 0x4d, 0x00, 0x2a, 0, 0, 1, 0x65, 0xaa];
        assert_eq!(
            prepare_access_unit(changed.clone(), &mut cache).unwrap(),
            changed
        );
        assert!(cache.pps.is_none());
        assert_eq!(cache.sps_descriptor(), Some([0x4d, 0x00, 0x2a]));
    }

    #[test]
    fn identical_sps_with_different_start_code_retains_matching_pps() {
        let mut cache = ParameterSets {
            sps: Some(vec![0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f]),
            pps: Some(vec![0, 0, 1, 0x68, 0xbb]),
        };
        let repeated = vec![
            0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x65, 0xaa,
        ];
        assert_eq!(
            prepare_access_unit(repeated, &mut cache).unwrap(),
            vec![
                0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x68, 0xbb, 0, 0, 0,
                1, 0x65, 0xaa,
            ]
        );
        assert!(cache.pps.is_some());

        let mut cache = ParameterSets {
            sps: Some(vec![0, 0, 1, 0x67, 0x42, 0xe0, 0x1f]),
            pps: None,
        };
        let pps_idr = vec![0, 0, 0, 1, 0x68, 0xcc, 0, 0, 1, 0x65, 0xdd];
        assert_eq!(
            prepare_access_unit(pps_idr, &mut cache).unwrap(),
            vec![0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x68, 0xcc, 0, 0, 1, 0x65, 0xdd,]
        );
    }

    #[test]
    fn h264_fmtp_matches_profile_level_and_bitrate() {
        let baseline = h264_codec(NativeH264Profile::Baseline, 1280, 720, 60, 20).unwrap();
        assert!(baseline.sdp_fmtp_line.contains("profile-level-id=42e020"));
        let high_1080 = h264_codec(NativeH264Profile::High, 1920, 1080, 60, 20).unwrap();
        assert!(high_1080.sdp_fmtp_line.contains("profile-level-id=64002a"));
        let high_1080_80 = h264_codec(NativeH264Profile::High, 1920, 1080, 60, 80).unwrap();
        assert!(high_1080_80
            .sdp_fmtp_line
            .contains("profile-level-id=640032"));
        let high_4k = h264_codec(NativeH264Profile::High, 3840, 2160, 60, 80).unwrap();
        assert!(high_4k.sdp_fmtp_line.contains("profile-level-id=640034"));
        let main_1080 = h264_codec(NativeH264Profile::Main, 1920, 1080, 60, 20).unwrap();
        assert!(main_1080.sdp_fmtp_line.contains("profile-level-id=4d002a"));
        let high_720_240 = h264_codec(NativeH264Profile::High, 1280, 720, 240, 20).unwrap();
        assert!(high_720_240
            .sdp_fmtp_line
            .contains("profile-level-id=640033"));
        let high_1080_120 = h264_codec(NativeH264Profile::High, 1920, 1080, 120, 20).unwrap();
        assert!(high_1080_120
            .sdp_fmtp_line
            .contains("profile-level-id=640033"));
        assert!(h264_codec(NativeH264Profile::High, 2560, 1440, 240, 20).is_err());
    }

    #[test]
    fn diagnostic_peer_is_anonymous_and_bounded_to_transport_metrics() {
        let peer = NativePeerDiagnostics {
            slot: 1,
            preview: false,
            connection_state: "connected".to_owned(),
            ice_connection_state: "connected".to_owned(),
            signaling_state: "stable".to_owned(),
            answer_applied: true,
            pending_candidates: 0,
            direct_only: false,
            dropped_frames: 0,
            packets_sent: 12,
            bytes_sent: 3_456,
            packets_received: 11,
            packets_lost: 1,
            nack_count: 2,
            pli_count: 1,
            fir_count: 0,
            round_trip_time_ms: Some(25.0),
        };
        let json = serde_json::to_value(peer).unwrap();
        assert_eq!(json["slot"], 1);
        assert_eq!(json["bytesSent"], 3_456);
        for sensitive in ["peerId", "sdp", "candidate", "address", "url", "credential"] {
            assert!(json.get(sensitive).is_none());
        }
    }

    fn keyframe_unit() -> Vec<u8> {
        vec![
            0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xaa, 0, 0, 1, 0x68, 0xbb, 0, 0, 1, 0x65, 0xcc,
        ]
    }

    fn delta_unit() -> Vec<u8> {
        vec![0, 0, 0, 1, 0x41, 0x11, 0x22]
    }

    #[test]
    fn capture_clock_holds_the_nominal_grid_and_resynchronizes_after_a_stall() {
        let mut clock = CaptureClock::new(120);
        let start = Instant::now();
        assert_eq!(clock.advance(start), 0);
        // Several access units routinely arrive in one pipe read. Their spacing
        // must stay on the encoder's grid rather than collapsing to zero.
        let burst = start + Duration::from_millis(9);
        let first = clock.advance(burst);
        let second = clock.advance(burst);
        let third = clock.advance(burst);
        assert_eq!(first, 750);
        assert_eq!(second, 1_500);
        assert_eq!(third, 2_250);
        // A genuine stall must move the clock by the real elapsed time so the
        // receiver's playout does not drift permanently behind wall time.
        let stalled = clock.advance(burst + Duration::from_millis(500));
        assert!(
            (44_000..=46_000).contains(&stalled),
            "a 500 ms stall should advance about 45000 ticks, got {stalled}"
        );
    }

    #[test]
    fn capture_clock_never_lets_one_gap_run_away() {
        let mut clock = CaptureClock::new(60);
        let start = Instant::now();
        clock.advance(start);
        let ticks = clock.advance(start + Duration::from_secs(600));
        assert_eq!(u64::from(ticks), MAX_FRAME_GAP_TICKS as u64);
    }

    #[test]
    fn pacer_spreads_a_burst_without_stalling_on_a_single_packet() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let mut pacer = Pacer::new(20_000_000.0 * PACE_HEADROOM);
                let packet_bits = (RTP_MTU + RTP_WIRE_OVERHEAD) as f64 * 8.0;
                // A 2 Mbit keyframe is about 200 packets at this MTU. Draining it
                // must take real time, and must still finish promptly.
                let started = Instant::now();
                for _ in 0..200 {
                    pacer.consume(packet_bits).await;
                }
                let elapsed = started.elapsed();
                assert!(
                    elapsed >= Duration::from_millis(10),
                    "pacing must spread the burst, took {elapsed:?}"
                );
                assert!(
                    elapsed < Duration::from_millis(400),
                    "pacing must not throttle below the target rate, took {elapsed:?}"
                );
                // A packet larger than the whole bucket must still be sent.
                pacer.consume(pacer.burst_bits * 4.0).await;
            });
    }

    #[test]
    fn a_stalled_viewer_drops_its_own_frames_instead_of_blocking_capture() -> Result<(), String> {
        // A current-thread runtime keeps the viewer's writer task parked for the
        // whole burst, which is exactly the "viewer cannot keep up" case.
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?
            .block_on(async {
                let hub = NativeScreenRtcHub::new(
                    "stalled-viewer".to_owned(),
                    NativeH264Profile::Baseline,
                    1920,
                    1080,
                    120,
                    20,
                )?;
                hub.create_peer("viewer".to_owned(), vec![], true).await?;
                let started = Instant::now();
                let burst = PEER_QUEUE_FRAMES * 4;
                for index in 0..burst {
                    let unit = if index == 0 {
                        keyframe_unit()
                    } else {
                        delta_unit()
                    };
                    // Never awaits, so the writer task cannot drain in between.
                    hub.write_access_unit(unit, Instant::now())?;
                }
                let elapsed = started.elapsed();
                assert!(
                    elapsed < Duration::from_millis(250),
                    "capture must never wait on a viewer, took {elapsed:?}"
                );
                let diagnostics = hub.diagnostics().await;
                assert_eq!(diagnostics.access_units, burst as u64);
                assert_eq!(diagnostics.keyframes, 1);
                assert!(
                    diagnostics.dropped_frames >= (burst - PEER_QUEUE_FRAMES - 1) as u64,
                    "an overflowing viewer must drop its own frames, dropped {}",
                    diagnostics.dropped_frames
                );
                assert_eq!(
                    diagnostics.peers.first().map(|peer| peer.dropped_frames),
                    Some(diagnostics.dropped_frames),
                    "drops must be attributed to the viewer that could not keep up"
                );
                hub.close().await;
                Ok(())
            })
    }

    /// The sender packetizes H.264 itself instead of using `write_sample`, so a
    /// real peer must reassemble exactly what capture produced, including a
    /// fragmented keyframe, and must see the capture clock on the wire.
    #[test]
    fn packetized_frames_reassemble_on_a_real_peer_with_capture_timestamps() -> Result<(), String> {
        use webrtc::rtp::{codecs::h264::H264Packet, packetizer::Depacketizer};

        let annex_b = |kind: u8, body: &[u8]| {
            let mut unit = vec![0, 0, 0, 1, kind];
            unit.extend_from_slice(body);
            unit
        };
        // Never zero, so no payload byte sequence can imitate a start code.
        let filler = |len: usize| (0..len).map(|i| (i % 251 + 1) as u8).collect::<Vec<_>>();
        let sps = annex_b(0x67, &[0x42, 0xe0, 0x1f, 0xaa, 0xbb]);
        let pps = annex_b(0x68, &[0xce, 0x3c, 0x80]);
        // Comfortably past the MTU, so this keyframe must travel as FU-A.
        let idr = annex_b(0x65, &filler(3_000));
        let delta = annex_b(0x41, &filler(500));
        let mut keyframe = annex_b(0x09, &[0x10]);
        keyframe.extend_from_slice(&sps);
        keyframe.extend_from_slice(&pps);
        keyframe.extend_from_slice(&idr);
        let mut delta_unit = annex_b(0x09, &[0x30]);
        delta_unit.extend_from_slice(&delta);
        // Access unit delimiters are not carried in RTP; everything else is.
        let mut expected = sps.clone();
        expected.extend_from_slice(&pps);
        expected.extend_from_slice(&idr);
        for _ in 0..3 {
            expected.extend_from_slice(&delta);
        }

        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?
            .block_on(async {
                let hub = NativeScreenRtcHub::new(
                    "loopback".to_owned(),
                    NativeH264Profile::Baseline,
                    1920,
                    1080,
                    120,
                    20,
                )?;

                let mut media_engine = MediaEngine::default();
                let registry = register_default_interceptors(Registry::new(), &mut media_engine)
                    .map_err(public_error)?;
                media_engine
                    .register_codec(
                        RTCRtpCodecParameters {
                            capability: h264_codec(NativeH264Profile::Baseline, 1920, 1080, 120, 20)?,
                            payload_type: 125,
                            ..Default::default()
                        },
                        RTPCodecType::Video,
                    )
                    .map_err(public_error)?;
                let receiver = Arc::new(
                    APIBuilder::new()
                        .with_media_engine(media_engine)
                        .with_interceptor_registry(registry)
                        .build()
                        .new_peer_connection(RTCConfiguration::default())
                        .await
                        .map_err(public_error)?,
                );
                let (received, mut packets) = mpsc::unbounded_channel();
                receiver.on_track(Box::new(move |track, _, _| {
                    let received = received.clone();
                    Box::pin(async move {
                        tokio::spawn(async move {
                            while let Ok((packet, _)) = track.read_rtp().await {
                                if received
                                    .send((packet.header.timestamp, packet.payload))
                                    .is_err()
                                {
                                    return;
                                }
                            }
                        });
                    })
                }));

                let offer = hub.create_peer("acceptance".to_owned(), vec![], true).await?;
                receiver
                    .set_remote_description(
                        RTCSessionDescription::offer(offer.sdp).map_err(public_error)?,
                    )
                    .await
                    .map_err(public_error)?;
                let answer = receiver.create_answer(None).await.map_err(public_error)?;
                let mut gathering = receiver.gathering_complete_promise().await;
                receiver
                    .set_local_description(answer)
                    .await
                    .map_err(public_error)?;
                tokio::time::timeout(Duration::from_secs(10), gathering.recv())
                    .await
                    .map_err(|_| "receiver ICE gathering timed out".to_owned())?;
                // Both descriptions already carry their gathered host candidates.
                let answer = receiver
                    .local_description()
                    .await
                    .ok_or("receiver produced no answer")?;
                hub.set_answer("acceptance", answer.sdp).await?;

                let connected = tokio::time::timeout(Duration::from_secs(20), async {
                    while receiver.connection_state()
                        != webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Connected
                    {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                })
                .await;
                if connected.is_err() {
                    hub.close().await;
                    let _ = receiver.close().await;
                    return Err("loopback peer never connected".to_owned());
                }

                hub.write_access_unit(keyframe.clone(), Instant::now())?;
                for _ in 0..3 {
                    hub.write_access_unit(delta_unit.clone(), Instant::now())?;
                }

                let mut depacketizer = H264Packet::default();
                let mut assembled = Vec::new();
                let mut timestamps = Vec::new();
                let collected = tokio::time::timeout(Duration::from_secs(10), async {
                    while assembled.len() < expected.len() {
                        let Some((timestamp, payload)) = packets.recv().await else {
                            return;
                        };
                        if timestamps.last() != Some(&timestamp) {
                            timestamps.push(timestamp);
                        }
                        if let Ok(unit) = depacketizer.depacketize(&payload) {
                            assembled.extend_from_slice(&unit);
                        }
                    }
                })
                .await;
                hub.close().await;
                let _ = receiver.close().await;
                collected.map_err(|_| {
                    format!(
                        "receiver reassembled {} of {} bytes",
                        assembled.len(),
                        expected.len()
                    )
                })?;

                assert_eq!(
                    assembled, expected,
                    "every NAL unit must survive packetization byte for byte"
                );
                assert_eq!(timestamps.len(), 4, "one RTP timestamp per access unit");
                for pair in timestamps.windows(2) {
                    assert_eq!(
                        pair[1].wrapping_sub(pair[0]),
                        750,
                        "120 FPS must place frames 750 ticks apart on the wire"
                    );
                }
                Ok(())
            })
    }

    #[test]
    fn candidate_before_answer_is_queued_and_drained() -> Result<(), String> {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?
            .block_on(async {
                let hub = NativeScreenRtcHub::new(
                    "candidate-order".to_owned(),
                    NativeH264Profile::Baseline,
                    1280,
                    720,
                    60,
                    8,
                )?;
                let offer = hub
                    .create_peer("receiver".to_owned(), vec![], false)
                    .await?;

                let codec = h264_codec(NativeH264Profile::Baseline, 1280, 720, 60, 8)?;
                let mut media_engine = MediaEngine::default();
                media_engine
                    .register_codec(
                        RTCRtpCodecParameters {
                            capability: codec,
                            payload_type: 125,
                            ..Default::default()
                        },
                        RTPCodecType::Video,
                    )
                    .map_err(public_error)?;
                let registry = register_default_interceptors(Registry::new(), &mut media_engine)
                    .map_err(public_error)?;
                let receiver_api = APIBuilder::new()
                    .with_media_engine(media_engine)
                    .with_interceptor_registry(registry)
                    .build();
                let receiver = receiver_api
                    .new_peer_connection(RTCConfiguration::default())
                    .await
                    .map_err(public_error)?;
                receiver
                    .set_remote_description(
                        RTCSessionDescription::offer(offer.sdp).map_err(public_error)?,
                    )
                    .await
                    .map_err(public_error)?;
                let answer = receiver.create_answer(None).await.map_err(public_error)?;
                let mut gathering = receiver.gathering_complete_promise().await;
                receiver
                    .set_local_description(answer)
                    .await
                    .map_err(public_error)?;
                tokio::time::timeout(Duration::from_secs(5), gathering.recv())
                    .await
                    .map_err(|_| "receiver ICE gathering timed out".to_owned())?;
                let answer = receiver
                    .local_description()
                    .await
                    .ok_or("receiver produced no answer")?;
                let candidate = answer
                    .sdp
                    .lines()
                    .find_map(|line| line.strip_prefix("a=candidate:"))
                    .map(|line| NativeIceCandidate {
                        candidate: format!("candidate:{line}"),
                        sdp_mid: Some("0".to_owned()),
                        sdp_mline_index: Some(0),
                        username_fragment: None,
                    })
                    .ok_or("receiver answer contained no ICE candidate")?;

                hub.add_candidate("receiver", candidate).await?;
                {
                    let signaling = Arc::clone(&lock(&hub.peers)["receiver"].signaling);
                    let signaling = signaling.lock().await;
                    assert!(!signaling.answered);
                    assert_eq!(signaling.pending_candidates.len(), 1);
                }
                hub.set_answer("receiver", answer.sdp).await?;
                {
                    let signaling = Arc::clone(&lock(&hub.peers)["receiver"].signaling);
                    let signaling = signaling.lock().await;
                    assert!(signaling.answered);
                    assert!(signaling.pending_candidates.is_empty());
                }
                hub.remove_peer("receiver").await?;
                assert_eq!(hub.peer_count(), 0);
                assert!(hub.remove_peer("receiver").await.is_err());
                receiver.close().await.map_err(public_error)?;

                hub.create_peer("bounded".to_owned(), vec![], true).await?;
                let host = || NativeIceCandidate {
                    candidate: "candidate:1 1 udp 2122260223 127.0.0.1 50000 typ host".to_owned(),
                    sdp_mid: Some("0".to_owned()),
                    sdp_mline_index: Some(0),
                    username_fragment: None,
                };
                for _ in 0..256 {
                    hub.add_candidate("bounded", host()).await?;
                }
                assert!(hub.add_candidate("bounded", host()).await.is_err());
                assert!(hub
                    .add_candidate(
                        "bounded",
                        NativeIceCandidate {
                            candidate: "candidate:2 1 udp 1 192.0.2.1 50001 typ relay".to_owned(),
                            sdp_mid: Some("0".to_owned()),
                            sdp_mline_index: Some(0),
                            username_fragment: None,
                        },
                    )
                    .await
                    .is_err());
                hub.remove_peer("bounded").await?;
                hub.close().await;
                Ok(())
            })
    }
}
