//! Drives the sans-IO `sfu::Sfu` core against a single shared UDP socket.
//!
//! `sfu::Sfu` implements `sansio::Protocol`: it owns no sockets, threads, or
//! clock of its own — the caller feeds it datagrams and events, and drains
//! outgoing datagrams and events after every input. This module is that
//! caller: one dedicated tokio task owns the `Sfu` instance and the socket;
//! everything else (the WebSocket signaling handlers) talks to it only
//! through channels, never touching the engine directly.
//!
//! ICE, DTLS, SRTP, RTCP (including keyframe requests) are handled inside
//! `sfu`/`rtc`, not here — this file's job is purely moving bytes and events
//! between the network and the engine.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bytes::BytesMut;
use rtc::shared::{TaggedBytesMut, TransportContext, TransportProtocol};
use sansio::Protocol;
use sfu::{ClientId, RoomId, SFUEvent, Sfu, TaggedSFUEvent};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::telemetry::Telemetry;

/// One entry per currently-connected signaling client: where to deliver
/// `SFUEvent`s addressed to it. Registered on Join, removed on Leave/socket
/// close. A brief `std::sync::Mutex` hold (never across an `.await`) is fine
/// here — this is touched on join/leave, not on the per-packet hot path.
type Routes = Arc<Mutex<HashMap<(RoomId, ClientId), mpsc::UnboundedSender<SFUEvent>>>>;

#[derive(Clone)]
pub struct EngineHandle {
    inbound: mpsc::UnboundedSender<TaggedSFUEvent>,
    routes: Routes,
    telemetry: Telemetry,
}

impl EngineHandle {
    /// Feed one client-originated event (Join/SessionDescription/IceCandidate/Leave)
    /// into the engine.
    pub fn send(&self, event: SFUEvent) {
        let tagged = TaggedSFUEvent { now: Instant::now(), event };
        if self.inbound.send(tagged).is_err() {
            warn!("engine task is gone; dropping event");
        }
    }

    /// Registers where events for `(room_id, client_id)` should be delivered
    /// and returns the receiving half. Call once per signaling connection,
    /// before sending its Join event.
    pub fn register(&self, room_id: RoomId, client_id: ClientId) -> mpsc::UnboundedReceiver<SFUEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.routes.lock().expect("routes mutex poisoned").insert((room_id, client_id), tx);
        rx
    }

    pub fn unregister(&self, room_id: RoomId, client_id: ClientId) {
        self.routes.lock().expect("routes mutex poisoned").remove(&(room_id, client_id));
    }

    pub fn telemetry(&self) -> Telemetry {
        self.telemetry.clone()
    }
}

/// Spawns the engine task and returns a handle for signaling code to talk to
/// it. Binds `udp_addr` as the single shared media socket.
pub async fn spawn(
    sfu_id: u64,
    udp_addr: SocketAddr,
    public_media_addr: SocketAddr,
    telemetry: Telemetry,
) -> anyhow::Result<EngineHandle> {
    let socket = Arc::new(UdpSocket::bind(udp_addr).await?);
    info!(%udp_addr, %public_media_addr, "media socket bound");

    let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
    let routes: Routes = Arc::new(Mutex::new(HashMap::new()));

    let handle = EngineHandle { inbound: inbound_tx, routes: routes.clone(), telemetry: telemetry.clone() };

    tokio::spawn(run(sfu_id, public_media_addr, socket, inbound_rx, routes, telemetry));

    Ok(handle)
}

async fn run(
    sfu_id: u64,
    public_media_addr: SocketAddr,
    socket: Arc<UdpSocket>,
    mut inbound_rx: mpsc::UnboundedReceiver<TaggedSFUEvent>,
    routes: Routes,
    telemetry: Telemetry,
) {
    let mut engine = Sfu::new(sfu_id, public_media_addr);
    let mut buf = vec![0u8; 1500];

    loop {
        let timeout = engine.poll_timeout();
        let sleep = async {
            match timeout {
                Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                // No pending timers: park on a long sleep so the branch stays
                // cancel-safe and select! doesn't spin. Any real event
                // (packet/inbound) wakes the loop immediately regardless.
                None => tokio::time::sleep(std::time::Duration::from_secs(3600)).await,
            }
        };

        tokio::select! {
            biased;

            received = socket.recv_from(&mut buf) => {
                match received {
                    Ok((n, peer_addr)) => {
                        let msg = TaggedBytesMut {
                            now: Instant::now(),
                            transport: TransportContext {
                                local_addr: public_media_addr,
                                peer_addr,
                                transport_protocol: TransportProtocol::UDP,
                                ecn: None,
                            },
                            message: BytesMut::from(&buf[..n]),
                        };
                        if let Err(e) = engine.handle_read(msg) {
                            warn!(error = %e, %peer_addr, "engine rejected inbound packet");
                        }
                    }
                    Err(e) => warn!(error = %e, "udp recv error"),
                }
            }

            event = inbound_rx.recv() => {
                match event {
                    Some(tagged) => {
                        if let Err(e) = engine.handle_event(tagged) {
                            warn!(error = %e, "engine rejected inbound event");
                        }
                    }
                    None => {
                        info!("all signaling handles dropped, shutting down engine task");
                        return;
                    }
                }
            }

            _ = sleep => {
                if let Err(e) = engine.handle_timeout(Instant::now()) {
                    warn!(error = %e, "engine timeout handling error");
                }
            }
        }

        drain(&mut engine, &socket, &routes, &telemetry).await;
    }
}

/// Flushes every pending outgoing datagram and event after one input was
/// handled. `Sfu::poll_write`/`poll_event` are plain queue pops (not
/// blocking), so this loop always terminates.
async fn drain(engine: &mut Sfu, socket: &UdpSocket, routes: &Routes, telemetry: &Telemetry) {
    while let Some(transmit) = engine.poll_write() {
        if let Err(e) = socket.send_to(&transmit.message, transmit.transport.peer_addr).await {
            warn!(error = %e, peer = %transmit.transport.peer_addr, "udp send error");
        }
    }

    while let Some(tagged) = engine.poll_event() {
        route_event(tagged.event, routes, telemetry);
    }
}

fn route_event(event: SFUEvent, routes: &Routes, telemetry: &Telemetry) {
    let room_id = event.room_id();
    let client_id = event.client_id();

    match &event {
        SFUEvent::Join { room_id, client_id, .. } => {
            telemetry.peer_joined(*room_id, *client_id);
            debug!(%room_id, client_id, "peer joined");
        }
        SFUEvent::Leave { room_id, client_id, reason, .. } => {
            telemetry.peer_left(*room_id, *client_id);
            debug!(%room_id, client_id, reason, "peer left");
        }
        SFUEvent::Err { reason, .. } => warn!(reason, "sfu reported error"),
        _ => {}
    }

    let (Some(room_id), Some(client_id)) = (room_id, client_id) else {
        // Ok/Err without a target client: nothing to route, already logged above.
        return;
    };

    let sender = routes.lock().expect("routes mutex poisoned").get(&(room_id, client_id)).cloned();
    match sender {
        Some(tx) => {
            if tx.send(event).is_err() {
                debug!(%room_id, client_id, "dropping event for closed signaling connection");
            }
        }
        None => debug!(%room_id, client_id, "dropping event for unregistered client"),
    }
}
