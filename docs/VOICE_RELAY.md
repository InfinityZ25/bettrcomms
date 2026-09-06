# Server voice fallback

Direct WebRTC remains the default. If a peer has not connected after eight seconds, the client attempts a microphone-only WebSocket relay on the same authenticated API origin. Settings → Connection also offers Server voice compatibility mode for an explicit test or a restrictive network. Direct connections only prevents both outgoing and incoming server-voice negotiation. Settings apply when joining a new call.

Camera, screen video, and captured system/application audio still use WebRTC. A working server voice connection does not imply those sources can cross a restrictive NAT. This relay does not replace TURN for video.

## Transport and quality

The fallback uses WebCodecs Opus, 48 kHz mono, 20 ms frames, starting at 64 kbps per receiving friend. It takes the already-processed microphone track and preserves its mute state. Congestion can reduce the bitrate. Unsupported WebCodecs audio/track processing is reported; direct WebRTC remains available in those runtimes. macOS WebKit compatibility requires actual device acceptance and is not inferred from the packaged build.

`/api/v1/rooms/{room}/voice-relay` is a separate WebSocket from signaling. The API requires a valid session, the exact permitted Origin, room membership, and an active signaling connection. Each relay connection belongs to that specific signaling connection. Replacing it, leaving, logout, a kick, or room deletion revokes relay access. Sender IDs are assigned by the server; the client cannot choose its identity. Forwarding is limited to eight targets per connection, with bounded frame size and a token-bucket rate limit.

The server keeps at most ten pending frames per recipient, dropping the oldest when full, expires frames older than 200 ms before writing, and limits an individual write to one second. Client encode/decode/crypto queues and socket buffering are bounded. The playback worklet retains at most approximately 120 ms. These bounds do not bound TCP's internal retransmission delay: already-sent bytes cannot be withdrawn. A stalled path can still cause an audible pause. This is a compatibility route, not a guarantee of UDP-like latency.

Recovery uses a five-second stable WebRTC check and a fresh readiness probe acknowledged by the other caller. Only the current probe can restore direct audio. The player exposes one microphone source per friend; it does not mix both routes. Local volume/normalization remains downstream of recording. A returning recording track creates a new distinct segment with its timing preserved.

## Encryption and trust

The relay forwards AES-256-GCM ciphertext. Ephemeral P-256 ECDH establishes a shared secret over authenticated room signaling; HKDF derives separate sending/receiving keys, bound to the two identities and the relay epoch. Sequence numbers form per-direction nonces and are authenticated with the peer identities and epoch. Replayed or modified packets are rejected. Reconnection rotates keys; duplicate negotiation messages must not reset the nonce counter.

Connection diagnostics exposes a session verification code. Comparing it through another trusted channel verifies the negotiated keys. Without that comparison, users trust the signaling service to deliver public keys honestly; this protocol does not independently authenticate identity keys against an actively malicious signaling service. Nor does it protect against a compromised client or web application delivery origin. It has not undergone an external cryptographic audit.

Media payloads are not logged or persisted by the relay. The service can observe participant IDs, room membership, packet timing, and byte sizes. User-requested recordings remain on the recording user's device. There is no server-side call recording or rewind buffer. The relay runs in the existing Railway application's configured region; this change does not add region selection. It can be hosted independently with the API, but voice and signaling currently share the same in-memory Hub and must reach the same process.

## Operations and verification

The current deployment uses one API replica. Restarting or deploying it ends active signaling/call sessions; users rejoin. Relay socket interruptions within a live signaling session have bounded reconnection attempts. There is no distributed room routing or load-tested large-group capacity.

Run Go tests with `TEST_DATABASE_URL` pointing to local Docker PostgreSQL, plus `go vet ./...`. Browser acceptance uses `tests/voice-codec.spec.ts`, `tests/voice-relay.spec.ts`, and `tests/recording-route-switch.spec.ts` against the local API and Vite server. Synthetic decoded audio establishes the local media path, not acoustic quality, external NAT behavior, or real packet-loss latency. Public deployment smoke tests check the unauthenticated boundary without enabling production development login.
