# Media architecture: current state and SFU migration

This note grounds the SFU migration in what the repository and live
infrastructure actually contain as of 2026-09-11, not in assumption. It
precedes any code/infra changes made as part of that migration.

## Current state

### Signaling (keep as-is)

`server/internal/api/hub.go` runs one in-process `Hub` per Go replica.
`GET /api/v1/rooms/{room}/ws` (WebSocket, `websocket()` in hub.go) relays
`offer` / `answer` / `ice-candidate` / `track-metadata` / `presence` /
`ping` frames between room members by `to`/`from` peer ID. It never
inspects or carries RTP — this is a pure signaling relay and stays that
way under the new architecture. `track-metadata` exists because WebRTC
only tags a track as audio/video; the app layer needs it to tell camera
from screen-share and microphone from captured system audio.

State (room membership, presence, mute/deafen) lives in the `Hub`'s Go
maps, in memory, in a single replica (`railway.json` / Railway service
config: one instance). A deploy or restart drops all live signaling
sessions; clients rejoin. This has to be kept in mind for the SFU's own
session handling — same constraint applies there unless changed.

### Media plane: full mesh WebRTC, peer-to-peer only

`apps/web/src/media/engine.ts` (`MediaEngine`, ~1.3k lines) is a
"React-independent WebRTC mesh engine" (its own README says so). `addPeer()`
creates one `RTCPeerConnection` per remote participant with perfect
negotiation (deterministic polite/impolite roles from peer ID comparison).
**There is no SFU today.** An N-person room is N·(N-1)/2 direct
PeerConnections; every participant uploads and downloads full-quality audio
+ camera + screen media to/from every other participant. This is the
primary scaling ceiling the SFU work replaces.

`apps/desktop/src-tauri/src/native_screen_rtc.rs` (~1.6k lines) runs a
**second**, independent WebRTC stack for native (non-WebView) screen
capture: it depends directly on `webrtc-rs` (`webrtc = "=0.17.2"` in
`apps/desktop/src-tauri/Cargo.toml`), constructing its own
`RTCPeerConnection` in Rust and interoperating over the same signaling
channel as the browser engine. This is useful precedent — the new SFU
should use the same `webrtc-rs` family, and idioms from this file
transfer directly.

### ICE / STUN / TURN

`GET /api/v1/ice` (`server/internal/api/api.go:ice`) returns STUN servers
from `ICE_URLS` (defaults to Google's public STUN) plus, only if
`TURN_SECRET` and `TURN_URLS` are set, a TURN entry with **ephemeral,
ID-bound, HMAC-SHA1-derived credentials** (10 minute TTL, coturn REST API
convention) — i.e. Phase 11's "expiring/derived TURN credentials"
requirement is already implemented correctly server-side. What's missing
is an actual TURN server: `TURN_URLS`/`TURN_SECRET` are **not set** in the
live Railway `bettrcomms` service (confirmed via `railway list-variables`).
`docs/TURN_VALIDATION.md` documents a local-only coturn-in-Docker
validation path; there is no production TURN deployment.
`apps/web/src/media/README.md` documents `direct-only` (STUN-only, no
relay candidates) vs `direct-preferred` (everything, browser's ICE agent
picks) — the client-side plumbing for a relay tier already exists, it has
nothing to talk to in production yet.

### The Railway media-relay violation

`server/internal/api/voice_relay.go` (`/api/v1/rooms/{room}/voice-relay`,
a WebSocket distinct from the signaling socket) is a **fallback microphone
relay through the Railway process itself**. Per `docs/VOICE_RELAY.md`: if
direct WebRTC hasn't connected within 8 seconds, the client sends
AES-256-GCM-encrypted, WebCodecs-Opus-encoded audio frames over this
socket and the Go `Hub` forwards them (`voiceClient.enqueue`, bounded
10-frame queue, 200ms max age) to the intended recipient(s). The payload
is E2E encrypted (ephemeral P-256 ECDH + HKDF, keyed per room epoch) so
Railway cannot read the content, but it is still real-time media bytes
flowing `peer → Railway → peer` on every relayed frame. **This is exactly
the pattern the new architecture forbids** ("Railway backend: NEVER acts
as a media relay") and Phase 14 explicitly calls out removing it. It only
ever carried microphone audio — camera, screen, and system audio have
never gone through Railway.

### Native capture → WebRTC track mapping (already conforms)

Every platform funnels into ordinary WebRTC tracks already, matching
Phase 13's target shape: browser `getUserMedia`/`getDisplayMedia` →
`MediaStreamTrack`; desktop native capture
(`native_screen.rs`, `native_screen_rtc.rs`, `native_system_audio.rs`)
produces frames fed into the Rust `webrtc-rs` `RTCPeerConnection` or
piped back into the WebView's `RTCPeerConnection` via IPC, depending on
platform capability. No separate media protocol exists per platform today.

### Platforms

Only **web** (`apps/web`, Vite/React) and **desktop** (`apps/desktop`,
Tauri + Rust, Windows/macOS) exist in this repository. There is no mobile
app. Phase 13's mobile capture mapping is aspirational/future, not a
current gap.

### Infrastructure inventory (as of this migration's start)

- **Railway** (`bettrcomms` project, `id 465e356f-…`): one Go service
  (`bettrcomms`, serves API + WebSockets + built static frontend from one
  Dockerfile) + one managed Postgres, both in the `production`
  environment, one replica. Public URL:
  `bettrcomms-production.up.railway.app` (no custom domain configured).
  `railway.json` — Railway's config-as-code format retires 2026-12-01,
  per `docs/DEPLOYMENT.md`; out of scope for this migration but noted.
- **Linode**: one instance already exists —
  `docker-one-click-us-southeast` (id `104939123`), created
  2026-09-11, region `us-southeast`, `g6-nanode-1` (**1 vCPU / 1GB RAM /
  25GB disk**, matches the task's stated resource ceiling exactly),
  public IPv4 `74.207.235.154` + a IPv6 `/128`. "docker-one-click" image
  implies Docker ships preinstalled via Linode's Marketplace app; this
  needs to be confirmed, not assumed, once we SSH in.
- **Linode Cloud Firewall** `btr` (id `163633958`), already attached to
  that instance: inbound policy `DROP`, outbound `ACCEPT`; only rules
  present are inbound TCP 22 (SSH, open to `0.0.0.0/0` + `::/0`) and
  inbound ICMP (open to both). No media ports open yet — this is a
  correct, minimal starting point to add to, not replace.
- **No DNS/TLS provider is connected or referenced anywhere in this
  project** (no Cloudflare MCP, no custom domain on Railway, no domain
  referenced in any doc or config). This blocks Phase 6 (public SFU
  hostname + trusted TLS cert) until resolved — flagged separately.

## Target state (this migration)

```text
                    Bettrcomms backend (Railway)
                       signaling / control only
                                |
                 +--------------+--------------+
                 |                             |
            Direct P2P                        SFU
          (existing mesh                   (new, Linode,
           engine, unchanged                webrtc-rs,
           wire format)                     forwarding only)
                 |                             |
            peer <-> peer              ICE/DTLS/SRTP -> RTP forward -> peers
```

- Signaling, presence, identity, room membership: **unchanged**, stays on
  Railway.
- `voice_relay.go` fallback: **removed**, replaced by "fall back to SFU
  (or TURN) instead of Railway" per the new policy.
- SFU: new standalone Rust service (webrtc-rs-based), deployed to the
  existing Linode instance, forwarding-only (no transcode), reachable at
  a TLS-terminated public hostname once a domain is available.
- P2P mesh path: preserved for 1:1 (and small-room, policy-dependent)
  calls; `MediaEngine` gains a second transport (`SfuWebRtcTransport`)
  behind the same `publish(track)` surface, selected by a new
  Automatic/Prefer-SFU/Prefer-P2P setting.
- TURN: still missing in production: needs a real coturn (or equivalent)
  deployment, most likely co-located on the same Linode box as a separate
  container, using the credential-issuing endpoint that already exists.

## Open blocker before Phase 6/7 can complete

Phase 6 requires a public hostname (e.g. `sfu.bettrcomms.<domain>`) with a
**publicly trusted** TLS certificate, and Phase 12 mentions integrating
with "the existing DNS architecture" if one exists. This repository and
the connected Railway/Linode accounts show **no domain and no DNS
provider** anywhere. This is a hard external dependency this session
cannot resolve on its own (no domain registrar or DNS MCP is connected) —
raised to the user directly rather than guessed at or invented.
