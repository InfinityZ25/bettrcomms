mod config;
mod engine;
mod health;
mod signaling;
mod telemetry;
mod token;

use axum::Router;
use axum::routing::get;
use tracing::info;
use tracing_subscriber::EnvFilter;

use config::Config;
use engine::EngineHandle;
use telemetry::Telemetry;

#[derive(Clone)]
pub struct AppState {
    engine: EngineHandle,
    config: std::sync::Arc<Config>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = Config::from_env()?;
    info!(?config.http_addr, ?config.udp_addr, ?config.public_media_addr, sfu_id = config.sfu_id, "starting bettrcomms-sfu");

    let telemetry = Telemetry::new();
    let engine = engine::spawn(config.sfu_id, config.udp_addr, config.public_media_addr, telemetry).await?;

    let state = AppState { engine, config: std::sync::Arc::new(config.clone()) };

    let app = Router::new()
        .route("/ws", get(signaling::handler))
        .route("/health", get(health::health))
        .route("/liveness", get(health::liveness))
        .route("/readiness", get(health::readiness))
        .route("/metrics", get(health::metrics))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(config.http_addr).await?;
    info!(addr = %config.http_addr, "signaling http server listening");

    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;

    info!("shut down cleanly");
    Ok(())
}

/// SIGTERM (what Docker sends on `docker stop`) or Ctrl-C, either triggers
/// axum's graceful shutdown: stop accepting new connections, let in-flight
/// requests finish. The engine task itself exits when its channels drop.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    info!("shutdown signal received, draining");
}
