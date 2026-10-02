//! Verifies short-lived join tokens minted by the Railway application
//! backend at `GET /api/v1/rooms/{room}/sfu-join`. After verifying the token,
//! the SFU holds a live API authorization lease for this peer and session.
//! It never talks to Postgres or WorkOS itself.
//!
//! Wire format (all base64url, no padding, joined by `.`):
//!   base64(json(Claims)) + "." + base64(HMAC-SHA256(secret, base64(json(Claims))))
//!
//! This mirrors the ephemeral-credential pattern `server/internal/api/api.go`
//! already uses for TURN (`ice()` handler) rather than introducing a new
//! trust mechanism or a JWT dependency for a single HMAC check.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Deserialize, serde::Serialize)]
pub struct Claims {
    pub room_id: Uuid,
    /// Bettrcomms user id (matches `users.id` on the Railway side).
    pub user_id: Uuid,
    /// Signaling peer id the client is publishing as; distinct from
    /// `user_id` so the same account can hold multiple devices in a room,
    /// same as the existing mesh signaling's `peer_id`.
    pub peer_id: Uuid,
    /// Public session identity, never the cookie or token hash.
    pub session_id: Uuid,
    /// Unix seconds this token stops being accepted.
    pub exp: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("malformed token")]
    Malformed,
    #[error("bad signature")]
    BadSignature,
    #[error("token expired")]
    Expired,
}

pub fn verify(token: &str, secret: &str) -> Result<Claims, TokenError> {
    let (payload_b64, sig_b64) = token.split_once('.').ok_or(TokenError::Malformed)?;

    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(payload_b64.as_bytes());
    let sig = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| TokenError::Malformed)?;
    // `verify_slice` is constant-time; do not replace with a manual `==`.
    mac.verify_slice(&sig)
        .map_err(|_| TokenError::BadSignature)?;

    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| TokenError::Malformed)?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| TokenError::Malformed)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is after 1970")
        .as_secs() as i64;
    if claims.exp <= now {
        return Err(TokenError::Expired);
    }
    Ok(claims)
}

/// Maps a Bettrcomms peer UUID onto the `sfu` crate's `u64` `ClientId`.
///
/// Hashes the entire UUID before truncation: clients choose their peer UUID,
/// so taking its low bytes would allow a deliberate collision with a peer.
/// Active route registration rejects duplicates, including a hash collision.
pub fn client_id_for(peer_id: Uuid) -> u64 {
    let hash = Sha256::digest(peer_id.as_bytes());
    u64::from_le_bytes(hash[..8].try_into().expect("SHA256 has 32 bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(secret: &str, claims: &Claims) -> String {
        let payload = serde_json::to_vec(claims).unwrap();
        let payload_b64 = URL_SAFE_NO_PAD.encode(&payload);
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(payload_b64.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{payload_b64}.{sig_b64}")
    }

    fn future_claims() -> Claims {
        Claims {
            room_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            session_id: Uuid::from_u128(99),
            peer_id: Uuid::new_v4(),
            exp: (std::time::SystemTime::now() + std::time::Duration::from_secs(60))
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
        }
    }

    #[test]
    fn accepts_a_freshly_signed_token() {
        let secret = "test-secret-at-least-32-bytes-long!";
        let claims = future_claims();
        let token = sign(secret, &claims);
        let verified = verify(&token, secret).expect("token should verify");
        assert_eq!(verified.room_id, claims.room_id);
        assert_eq!(verified.peer_id, claims.peer_id);
    }

    #[test]
    fn rejects_wrong_secret() {
        let claims = future_claims();
        let token = sign("secret-a-at-least-32-bytes-long!!!!", &claims);
        assert!(matches!(
            verify(&token, "secret-b-at-least-32-bytes-long!!!!"),
            Err(TokenError::BadSignature)
        ));
    }

    #[test]
    fn rejects_expired_token() {
        let secret = "test-secret-at-least-32-bytes-long!";
        let mut claims = future_claims();
        claims.exp = 1; // 1970
        let token = sign(secret, &claims);
        assert!(matches!(verify(&token, secret), Err(TokenError::Expired)));
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(
            verify("not-a-token", "secret"),
            Err(TokenError::Malformed)
        ));
    }

    #[test]
    fn client_id_is_deterministic() {
        let id = Uuid::new_v4();
        assert_eq!(client_id_for(id), client_id_for(id));
    }

    #[test]
    fn matching_uuid_suffix_does_not_hijack_another_peer() {
        let first = Uuid::parse_str("11111111-1111-4111-8111-222222222222").unwrap();
        let second = Uuid::parse_str("33333333-3333-4333-8111-222222222222").unwrap();
        assert_ne!(client_id_for(first), client_id_for(second));
    }
}
