//! Phase 7 health surface. No auth: only non-sensitive counts are exposed
//! (see telemetry.rs), matching "does not require authentication if only
//! minimal non-sensitive information is returned".
//!
//! - `/liveness`: process is up and its event loop is responsive.
//! - `/readiness`: additionally, the media socket is bound and accepting
//!   sessions. By construction the HTTP server here never starts until
//!   `engine::spawn` has already bound the UDP socket, so as long as this
//!   handler can run at all, readiness is true — there is no separate
//!   "still starting up" state to report.
//! - `/health`: both, plus the metrics snapshot, for a single-request check.
//! - `/metrics`: telemetry only (see telemetry.rs).

use axum::Json;
use axum::extract::State;
use serde::Serialize;

use crate::AppState;

#[derive(Serialize)]
pub struct Liveness {
    live: bool,
}

#[derive(Serialize)]
pub struct Readiness {
    ready: bool,
}

#[derive(Serialize)]
pub struct Health {
    live: bool,
    ready: bool,
    #[serde(flatten)]
    metrics: crate::telemetry::Snapshot,
}

pub async fn liveness() -> Json<Liveness> {
    Json(Liveness { live: true })
}

pub async fn readiness() -> Json<Readiness> {
    Json(Readiness { ready: true })
}

pub async fn health(State(state): State<AppState>) -> Json<Health> {
    Json(Health { live: true, ready: true, metrics: state.engine.telemetry().snapshot() })
}

pub async fn metrics(State(state): State<AppState>) -> Json<crate::telemetry::Snapshot> {
    Json(state.engine.telemetry().snapshot())
}
