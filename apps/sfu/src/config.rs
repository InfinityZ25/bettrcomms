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
    /// Trusted API endpoint for a live, revocable authorization lease.
    pub auth_url: String,
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
        let join_secret = std::env::var("SFU_JOIN_SECRET").map_err(|_| {
            anyhow::anyhow!(
                "SFU_JOIN_SECRET must be set and match the Railway API's SFU_JOIN_SECRET"
            )
        })?;
        if join_secret.len() < 32 {
            anyhow::bail!("SFU_JOIN_SECRET must be at least 32 bytes");
        }
        let sfu_id = env_or("SFU_ID", "1").parse()?;
        let auth_url = authorization_url(
            std::env::var("SFU_AUTH_URL").ok(),
            std::env::var("BETTERCOMMS_API_URL").ok(),
        )?;
        Ok(Self {
            http_addr,
            udp_addr,
            public_media_addr,
            join_secret,
            auth_url,
            sfu_id,
        })
    }
}

pub fn authorization_url(explicit: Option<String>, api: Option<String>) -> anyhow::Result<String> {
    let value = explicit.unwrap_or_else(|| {
        let origin = api.unwrap_or_else(|| "http://127.0.0.1:8080".to_string());
        let origin = origin.trim_end_matches('/');
        let origin = origin
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        format!("{origin}/api/v1/sfu/authorization")
    });
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let request = value.as_str().into_client_request().map_err(|_| {
        anyhow::anyhow!("SFU_AUTH_URL must be an absolute ws(s) API authorization endpoint")
    })?;
    let uri = request.uri();
    if !matches!(uri.scheme_str(), Some("ws" | "wss"))
        || uri.host().is_none()
        || uri.query().is_some()
        || value.contains('#')
        || value.contains('@')
    {
        anyhow::bail!("SFU_AUTH_URL must use ws(s) without credentials, query or fragment");
    }
    Ok(value)
}

#[cfg(test)]
mod authorization_tests {
    use super::authorization_url;
    #[test]
    fn derives_the_trusted_api_endpoint() {
        assert_eq!(
            authorization_url(None, Some("https://api.example.test/".into())).unwrap(),
            "wss://api.example.test/api/v1/sfu/authorization"
        );
        assert_eq!(
            authorization_url(None, None).unwrap(),
            "ws://127.0.0.1:8080/api/v1/sfu/authorization"
        );
    }
    #[test]
    fn rejects_unsafe_endpoints() {
        for value in [
            "file:///tmp/socket",
            "ws://user:pass@host/auth",
            "ws://host/auth?token=secret",
            "ws://host/auth#fragment",
        ] {
            assert!(authorization_url(Some(value.into()), None).is_err());
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
