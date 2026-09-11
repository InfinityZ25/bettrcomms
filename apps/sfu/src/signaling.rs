//! `GET /ws?token=...`: one WebSocket connection per publishing/subscribing
//! client. Bridges JSON wire messages to `sfu::SFUEvent`s.
//!
//! `RTCSessionDescription` and `RTCIceCandidateInit` (from the `rtc` crate)
//! already derive `Serialize`/`Deserialize` in the exact shape the
//! browser's native `RTCSessionDescriptionInit`/`RTCIceCandidateInit`
//! objects use (`{"type":"offer","sdp":"..."}`,
//! `{"candidate":"...","sdpMid":...,"sdpMLineIndex":...}`), so they cross
//! the wire with no translation layer.
//!
//! Room roster/presence (who's in the call, mute state) stays exactly where
//! it already is — Railway's existing signaling `Hub`
//! (`server/internal/api/hub.go`). This connection only ever carries this
//! one client's own publish/subscribe negotiation; it never broadcasts to
//! other clients.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::transport::RTCIceCandidateInit;
use serde::{Deserialize, Serialize};
use sfu::{RequestId, SFUEvent};
use tracing::{info, warn};

use crate::AppState;
use crate::token;

#[derive(Deserialize)]
pub struct WsQuery {
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
// One of these is constructed per SDP negotiation, not per packet; boxing
// the large variant would only add an allocation to the cold path.
#[allow(clippy::large_enum_variant)]
enum ClientMessage {
    Sdp { request_id: RequestId, sdp: RTCSessionDescription },
    Ice { request_id: RequestId, candidate: RTCIceCandidateInit },
    Leave,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
enum ServerMessage {
    Sdp { request_id: RequestId, sdp: RTCSessionDescription },
    Ice { request_id: RequestId, candidate: RTCIceCandidateInit },
    Error { request_id: RequestId, reason: String },
}

impl TryFrom<SFUEvent> for ServerMessage {
    type Error = ();

    fn try_from(event: SFUEvent) -> Result<ServerMessage, ()> {
        match event {
            SFUEvent::SessionDescription { request_id, sdp, .. } => Ok(ServerMessage::Sdp { request_id, sdp }),
            SFUEvent::IceCandidate { request_id, candidate, .. } => Ok(ServerMessage::Ice { request_id, candidate }),
            SFUEvent::Err { request_id, reason, .. } => Ok(ServerMessage::Error { request_id, reason }),
            // Join/Leave/Ok are engine-internal bookkeeping, not forwarded to the client.
            SFUEvent::Join { .. } | SFUEvent::Leave { .. } | SFUEvent::Ok { .. } => Err(()),
        }
    }
}

pub async fn handler(ws: WebSocketUpgrade, State(state): State<AppState>, Query(query): Query<WsQuery>) -> impl IntoResponse {
    match token::verify(&query.token, &state.config.join_secret) {
        Ok(claims) => ws.on_upgrade(move |socket| run(socket, state, claims)),
        Err(e) => {
            warn!(error = %e, "rejected sfu ws connection: bad join token");
            (axum::http::StatusCode::UNAUTHORIZED, "invalid or expired join token").into_response()
        }
    }
}

async fn run(mut socket: WebSocket, state: AppState, claims: token::Claims) {
    let room_id = claims.room_id;
    let client_id = token::client_id_for(claims.peer_id);
    info!(%room_id, client_id, user_id = %claims.user_id, "sfu client connected");

    let mut events = state.engine.register(room_id, client_id);
    state.engine.send(SFUEvent::Join { request_id: 0, room_id, client_id });

    loop {
        tokio::select! {
            biased;

            incoming = socket.recv() => {
                let Some(incoming) = incoming else { break };
                match incoming {
                    Ok(Message::Text(text)) => {
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(ClientMessage::Sdp { request_id, sdp }) => {
                                state.engine.send(SFUEvent::SessionDescription { request_id, room_id, client_id, sdp });
                            }
                            Ok(ClientMessage::Ice { request_id, candidate }) => {
                                state.engine.send(SFUEvent::IceCandidate { request_id, room_id, client_id, candidate });
                            }
                            Ok(ClientMessage::Leave) => break,
                            Err(e) => warn!(error = %e, %room_id, client_id, "malformed sfu ws message, ignoring"),
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {} // binary/ping/pong: nothing to do, axum answers pings itself
                    Err(e) => {
                        warn!(error = %e, %room_id, client_id, "sfu ws read error");
                        break;
                    }
                }
            }

            outgoing = events.recv() => {
                let Some(event) = outgoing else { break };
                if let Ok(message) = ServerMessage::try_from(event) {
                    let text = serde_json::to_string(&message).expect("ServerMessage always serializes");
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    state.engine.send(SFUEvent::Leave { request_id: 0, room_id, client_id, reason: "signaling connection closed".to_string() });
    state.engine.unregister(room_id, client_id);
    info!(%room_id, client_id, "sfu client disconnected");
}
