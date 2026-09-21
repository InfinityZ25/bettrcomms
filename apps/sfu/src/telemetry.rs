//! Minimal in-process observability (Phase 15): current peers/rooms and
//! process resource use, exposed as JSON at `GET /metrics`. No user-facing
//! content (names, emails, room names) is tracked or exposed here — only
//! counts and opaque ids, matching "do not expose user-sensitive metrics
//! publicly".
//!
//! Deliberately not Prometheus-formatted to avoid pulling in a metrics
//! crate on a 1GB box for a single box's worth of counters; `/metrics`
//! returns JSON instead. Revisit if/when this runs as more than one
//! instance and needs to be scraped centrally.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use sfu::{ClientId, RoomId};

#[derive(Default)]
struct State {
    rooms: HashMap<RoomId, HashSet<ClientId>>,
}

#[derive(Clone)]
pub struct Telemetry {
    started: Instant,
    state: Arc<Mutex<State>>,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub uptime_seconds: u64,
    pub active_rooms: usize,
    pub active_peers: usize,
    pub peers_per_room: Vec<RoomSnapshot>,
}

#[derive(Serialize)]
pub struct RoomSnapshot {
    pub room_id: RoomId,
    pub peers: usize,
}

impl Telemetry {
    pub fn new() -> Self {
        Self { started: Instant::now(), state: Arc::new(Mutex::new(State::default())) }
    }

    pub fn peer_joined(&self, room_id: RoomId, client_id: ClientId) {
        self.state.lock().expect("telemetry mutex poisoned").rooms.entry(room_id).or_default().insert(client_id);
    }

    pub fn peer_left(&self, room_id: RoomId, client_id: ClientId) {
        let mut state = self.state.lock().expect("telemetry mutex poisoned");
        if let Some(peers) = state.rooms.get_mut(&room_id) {
            peers.remove(&client_id);
            if peers.is_empty() {
                state.rooms.remove(&room_id);
            }
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let state = self.state.lock().expect("telemetry mutex poisoned");
        let peers_per_room: Vec<RoomSnapshot> =
            state.rooms.iter().map(|(room_id, peers)| RoomSnapshot { room_id: *room_id, peers: peers.len() }).collect();
        Snapshot {
            uptime_seconds: self.started.elapsed().as_secs(),
            active_rooms: state.rooms.len(),
            active_peers: peers_per_room.iter().map(|r| r.peers).sum(),
            peers_per_room,
        }
    }
}
