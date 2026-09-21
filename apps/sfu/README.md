# bettrcomms-sfu

Selective forwarding unit: forwards RTP/RTCP between WebRTC peers. Does not
transcode. Never touches Railway's request path — see
[../../docs/MEDIA_ARCHITECTURE.md](../../docs/MEDIA_ARCHITECTURE.md) for why
this exists and [../../docs/SFU_DEPLOYMENT.md](../../docs/SFU_DEPLOYMENT.md)
for how it's actually deployed and operated.

Built on [webrtc-rs/sfu](https://github.com/webrtc-rs/sfu), a sans-IO SFU
core: it owns no sockets, threads, or clock of its own. This crate is the
caller that drives it — one tokio task owns a single shared UDP socket
(`src/engine.rs`) and feeds/drains the engine; `src/signaling.rs` bridges
one WebSocket connection per client to the engine's `SFUEvent`s;
`src/token.rs` verifies the short-lived HMAC join tokens Railway's API
mints; `src/health.rs` / `src/telemetry.rs` are the ops surface.

## Local development

```sh
cargo build
cargo test
cargo clippy --all-targets

HTTP_ADDR=127.0.0.1:8443 \
UDP_ADDR=127.0.0.1:3478 \
PUBLIC_MEDIA_ADDR=127.0.0.1:3478 \
SFU_JOIN_SECRET=local-dev-secret-at-least-32-bytes-long!! \
cargo run
```

`curl http://127.0.0.1:8443/health` should return
`{"live":true,"ready":true,...}`.

To open a real WebSocket session you need a token signed with the same
`SFU_JOIN_SECRET` — the Go API's `sfuJoin` handler
(`server/internal/api/api.go`) mints these in the same HMAC-SHA256 scheme;
run the full stack per the repo's main dev instructions rather than
hand-rolling tokens, except for quick protocol-level testing.

## Why one UDP port, not a range

`sfu`'s `Demuxer` routes every inbound datagram to a `(RoomId, ClientId)`
pair by reading the STUN `USERNAME` attribute's local ufrag half (ICE-lite:
the SFU never initiates connectivity checks, it only answers). That means
one socket handles arbitrary concurrent sessions — session count is not
port-bound. The upstream `chat` example opens a port range instead, but
that's for horizontal sharding across worker threads at a scale this
single-box, single-vCPU deployment doesn't need; see
`src/config.rs`/`src/engine.rs` for the single-socket approach actually
used here.

## Known gaps (see MEDIA_ARCHITECTURE.md / the implementation report for the full list)

- No RTP-level load test performed yet.
- The web client's `SfuTransport`
  (`apps/web/src/media/sfuTransport.ts`) doesn't yet correlate a forwarded
  track back to a `MediaSourceKind` (camera vs screen vs mic) the way the
  mesh engine's `track-metadata` signal does.
- Railway's `SFU_URL`/`SFU_JOIN_SECRET`/`TURN_URLS`/`TURN_SECRET` aren't
  applied to the live service yet — that's a production redeploy left for
  an explicit, deliberate step (see the implementation report).
