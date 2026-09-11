use std::net::SocketAddr;

/// All configuration comes from the environment so the container never bakes
/// in secrets or host-specific values. See `.env.example` for the full list.
#[derive(Debug, Clone)]
pub struct Config {
    /// Address the HTTP/WebSocket signaling server binds to inside the
    /// container, e.g. `0.0.0.0:8443`. TLS termination happens in front of
    /// this (see docs/SFU_DEPLOYMENT.md) — the process itself speaks plain
    /// HTTP/WS behind a reverse proxy on the same host.
    pub http_addr: SocketAddr,
    /// Address the single shared UDP media socket binds to, e.g.
    /// `0.0.0.0:3478`. One socket handles every session: the sans-IO `sfu`
    /// crate demultiplexes by ICE ufrag (see `sfu::Sfu`'s `Demuxer`), so this
    /// does not need to scale with participant count.
    pub udp_addr: SocketAddr,
    /// Publicly reachable address clients should send media to — usually the
    /// box's public IPv4/IPv6 and the same port as `udp_addr`. This is what
    /// gets embedded as the ICE-lite candidate in every SDP answer, so it
    /// must be the address as seen from the internet, not a private/NAT
    /// address.
    pub public_media_addr: SocketAddr,
    /// Shared secret used to verify short-lived join tokens minted by the
    /// Railway application backend (`POST /api/v1/sfu/join`). Same HMAC
    /// scheme already used for TURN credentials in
    /// server/internal/api/api.go — no new trust mechanism introduced.
    pub join_secret: String,
    /// Numeric identifier for this SFU process, surfaced in `SFUEvent`
    /// routing and logs. A single box only ever needs one distinct value;
    /// this exists for when the deployment later grows to multiple SFUs.
    pub sfu_id: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let http_addr = env_or("HTTP_ADDR", "0.0.0.0:8443").parse()?;
        let udp_addr = env_or("UDP_ADDR", "0.0.0.0:3478").parse()?;
        let public_media_addr = std::env::var("PUBLIC_MEDIA_ADDR")
            .map_err(|_| anyhow::anyhow!("PUBLIC_MEDIA_ADDR must be set to this box's publicly reachable ip:port for media"))?
            .parse()?;
        let join_secret = std::env::var("SFU_JOIN_SECRET")
            .map_err(|_| anyhow::anyhow!("SFU_JOIN_SECRET must be set and match the Railway API's SFU_JOIN_SECRET"))?;
        if join_secret.len() < 32 {
            anyhow::bail!("SFU_JOIN_SECRET must be at least 32 bytes");
        }
        let sfu_id = env_or("SFU_ID", "1").parse()?;
        Ok(Self { http_addr, udp_addr, public_media_addr, join_secret, sfu_id })
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
