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
        Arc,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
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
    media::Sample,
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
    rtp_transceiver::{
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
        RTCPFeedback,
    },
    stats::StatsReportType,
    track::track_local::{track_local_static_sample::TrackLocalStaticSample, TrackLocal},
};

const MAX_PEERS: usize = 8;
const MAX_ACCESS_UNIT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PARAMETER_SET_BYTES: usize = 64 * 1024;
const ICE_GATHER_TIMEOUT: Duration = Duration::from_secs(15);

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

struct NativePeer {
    connection: Arc<RTCPeerConnection>,
    rtcp_task: JoinHandle<()>,
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
    track: Arc<TrackLocalStaticSample>,
    peers: Mutex<HashMap<String, NativePeer>>,
    peer_slots: Arc<Semaphore>,
    idr_requested: Arc<AtomicBool>,
    access_units: AtomicU64,
    keyframes: AtomicU64,
    encoded_bytes: AtomicU64,
    parameter_sets: Mutex<ParameterSets>,
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
        let codec = h264_codec(profile, width, height, fps, bitrate_mbps)?;
        let mut media_engine = MediaEngine::default();
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
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)
            .map_err(public_error)?;
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();
        let track = Arc::new(TrackLocalStaticSample::new(
            codec,
            format!("native-screen-video-{session_id}"),
            format!("native-screen-{session_id}"),
        ));
        Ok(Arc::new(Self {
            session_id,
            api: Arc::new(api),
            track,
            peers: Mutex::new(HashMap::new()),
            peer_slots: Arc::new(Semaphore::new(MAX_PEERS)),
            idr_requested: Arc::new(AtomicBool::new(false)),
            access_units: AtomicU64::new(0),
            keyframes: AtomicU64::new(0),
            encoded_bytes: AtomicU64::new(0),
            parameter_sets: Mutex::new(ParameterSets::default()),
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
        if self.peers.lock().await.contains_key(&peer_id) {
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
        let sender = match connection
            .add_track(Arc::clone(&self.track) as Arc<dyn TrackLocal + Send + Sync>)
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
        let mut peers = self.peers.lock().await;
        if self.closed.load(Ordering::Acquire) || peers.contains_key(&peer_id) {
            rtcp_task.abort();
            let _ = connection.close().await;
            return Err(if self.closed.load(Ordering::Relaxed) {
                "native screen WebRTC hub is closed".to_owned()
            } else {
                "native screen peer already exists".to_owned()
            });
        }
        peers.insert(
            peer_id.clone(),
            NativePeer {
                connection,
                rtcp_task,
                direct_only,
                signaling: Arc::new(Mutex::new(NativePeerSignaling::default())),
                _permit: permit,
            },
        );
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
        let peer = self
            .peers
            .lock()
            .await
            .remove(peer_id)
            .ok_or_else(|| "native screen peer was not found".to_owned())?;
        peer.rtcp_task.abort();
        peer.connection.close().await.map_err(public_error)
    }

    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.peer_slots.close();
        let peers = std::mem::take(&mut *self.peers.lock().await);
        for (_, peer) in peers {
            peer.rtcp_task.abort();
            let _ = peer.connection.close().await;
        }
    }

    /// Sends one complete Annex-B H.264 access unit to every bound peer.
    pub async fn write_access_unit(
        &self,
        annex_b: Vec<u8>,
        duration: Duration,
    ) -> Result<(), String> {
        if annex_b.is_empty() || annex_b.len() > MAX_ACCESS_UNIT_BYTES {
            return Err("native screen H.264 access unit has an invalid size".to_owned());
        }
        if duration.is_zero() || duration > Duration::from_secs(1) {
            return Err("native screen H.264 access unit has an invalid duration".to_owned());
        }
        if !has_annex_b_start_code(&annex_b) {
            return Err("native screen H.264 access unit is not Annex-B".to_owned());
        }
        let annex_b = {
            let mut parameter_sets = self.parameter_sets.lock().await;
            prepare_access_unit(annex_b, &mut parameter_sets)?
        };
        self.access_units.fetch_add(1, Ordering::Relaxed);
        self.encoded_bytes
            .fetch_add(annex_b.len() as u64, Ordering::Relaxed);
        if annex_b_has_idr(&annex_b) {
            self.keyframes.fetch_add(1, Ordering::Relaxed);
        }
        self.track
            .write_sample(&Sample {
                data: annex_b.into(),
                duration,
                ..Default::default()
            })
            .await
            .map_err(public_error)
    }

    /// Returns and clears the coalesced PLI/FIR request. The encoder should force
    /// its next access unit to IDR. A one-second periodic IDR remains mandatory.
    pub fn take_idr_request(&self) -> bool {
        self.idr_requested.swap(false, Ordering::AcqRel)
    }

    pub async fn peer_count(&self) -> usize {
        self.peers.lock().await.len()
    }

    pub async fn diagnostics(&self) -> NativeRtcDiagnostics {
        let parameter_sets = self.parameter_sets.lock().await;
        let sps = parameter_sets.sps_descriptor();
        drop(parameter_sets);
        let peers = self.peers.lock().await;
        let mut ordered = peers.iter().collect::<Vec<_>>();
        ordered.sort_by_key(|(peer_id, _)| *peer_id);
        let mut peer_diagnostics = Vec::with_capacity(ordered.len());
        for (index, (peer_id, peer)) in ordered.into_iter().enumerate() {
            let reports = peer.connection.get_stats().await;
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
            let signaling = peer.signaling.lock().await;
            peer_diagnostics.push(NativePeerDiagnostics {
                slot: (index + 1) as u8,
                preview: peer_id.as_str() == "__preview",
                connection_state: peer.connection.connection_state().to_string(),
                ice_connection_state: peer.connection.ice_connection_state().to_string(),
                signaling_state: peer.connection.signaling_state().to_string(),
                answer_applied: signaling.answered,
                pending_candidates: signaling.pending_candidates.len(),
                direct_only: peer.direct_only,
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
        self.peers
            .lock()
            .await
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
    packets_sent: u64,
    bytes_sent: u64,
    packets_received: u64,
    packets_lost: i64,
    nack_count: u64,
    pli_count: u64,
    fir_count: u64,
    round_trip_time_ms: Option<f64>,
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
                    let peers = hub.peers.lock().await;
                    let signaling = peers["receiver"].signaling.lock().await;
                    assert!(!signaling.answered);
                    assert_eq!(signaling.pending_candidates.len(), 1);
                }
                hub.set_answer("receiver", answer.sdp).await?;
                {
                    let peers = hub.peers.lock().await;
                    let signaling = peers["receiver"].signaling.lock().await;
                    assert!(signaling.answered);
                    assert!(signaling.pending_candidates.is_empty());
                }
                hub.remove_peer("receiver").await?;
                assert_eq!(hub.peer_count().await, 0);
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
