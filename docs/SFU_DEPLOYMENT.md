# SFU deployment

What's actually running, where, and how to operate it. Design rationale and
what this replaces live in [MEDIA_ARCHITECTURE.md](MEDIA_ARCHITECTURE.md);
this doc is the operational reference.

## Topology

```
                     Bettrcomms backend (Railway)
                        signaling / control only
                                  |
                    +-------------+-------------+
                    |                           |
                Direct P2P                     SFU
              (mesh, unchanged)         sfu.bettrcomms.com
                    |                           |
              peer <-> peer            ICE/DTLS/SRTP -> RTP forward -> peers
```

```
CONTROL PLANE (unchanged)              MEDIA PLANE
Native/Browser                         All clients
     |                                      |
WebSocket -> Railway Hub                  WebRTC
(signaling, presence, chat,          P2P mesh  |  SFU  |  TURN fallback
 SFU-join token minting)
```

## What's deployed, where

- **Linode instance** `docker-one-click-us-southeast` (id `104939123`),
  `g6-nanode-1`: 1 vCPU / 1GB RAM / 25GB disk, region `us-southeast`.
  Public IPv4 `74.207.235.154`, IPv6 `2600:3c02::2000:b2ff:fe9b:4b33`.
  Docker ships preinstalled (Marketplace one-click image) and is enabled at
  boot. A 2GB swapfile (`/swapfile`, persisted in `/etc/fstab`) was added on
  top of the box's existing 496MB swap partition — headroom for the Rust
  build and general reliability on a 1GB box, not required at runtime.
- **DNS**: `sfu.bettrcomms.com` A/AAAA records in Cloudflare, **DNS-only
  (grey cloud, not proxied)** — Cloudflare's proxy doesn't carry the SFU's
  raw UDP media or coturn's TURN traffic, and would only complicate the
  HTTP-01 challenge for no benefit here.
- **Code**: `/opt/bettrcomms-sfu` on the box, synced from `apps/sfu/` in
  this repo (not a git checkout — `rsync` from a developer machine or CI;
  see Deploying a change below).
- **Three containers** (`docker-compose.yml`), all `restart: unless-stopped`:
  - `caddy` (caddy:2-alpine) — TLS termination, automatic Let's Encrypt
    cert via HTTP-01 (port 80), reverse-proxies `sfu.bettrcomms.com` to
    the `sfu` container over the internal Docker network. Never touches
    media.
  - `sfu` (built from `apps/sfu/Dockerfile`) — the forwarding unit itself.
    Publishes UDP 3478 directly (not proxied).
  - `coturn` (coturn/coturn:4) — TURN fallback, `network_mode: host`,
    listening on 3479 (not 3478 — that's the SFU's port on the same box).

## Ports and firewall

Both the Linode Cloud Firewall (`btr`, id `163633958`) and the box's local
UFW carry the identical ruleset — defense in depth, not redundant by
accident:

| Port | Protocol | Purpose |
|---|---|---|
| 22 | TCP | SSH (pre-existing) |
| 80 | TCP | Caddy: ACME HTTP-01 challenge + redirect to 443 |
| 443 | TCP | Caddy: signaling (HTTPS/WSS) |
| 443 | UDP | Caddy: HTTP/3 |
| 3478 | UDP | SFU media (single shared socket — see below) |
| 3479 | TCP+UDP | coturn: STUN/TURN control |
| 5350 | TCP | coturn: TLS |
| 49160–49199 | UDP | coturn: TURN relay range (40 ports) |

Both firewalls default-DROP inbound / ACCEPT outbound; nothing else is
open. ICMP is allowed (Cloud Firewall only; UFW allows it by default).

**Why one UDP port for the SFU, not a range**: the `sfu` crate
(webrtc-rs/sfu) runs ICE-lite over one shared socket, demultiplexing
sessions by the ICE username fragment embedded in each STUN packet
(`{room_id}/{client_id}` encoded into the local ufrag) rather than by
source port. This is deliberate — see the port-minimization guidance this
deployment follows — and is why `PUBLIC_MEDIA_ADDR` in `.env` must be the
exact address embedded in every ICE-lite candidate the SFU advertises.

## Configuration

`apps/sfu/.env` (VPS-only, gitignored, never committed):

| Var | Meaning |
|---|---|
| `HTTP_ADDR` | signaling bind addr, `0.0.0.0:8443` |
| `UDP_ADDR` | media bind addr, `0.0.0.0:3478` |
| `PUBLIC_MEDIA_ADDR` | `74.207.235.154:3478` — publicly reachable, embedded in every SDP answer |
| `SFU_JOIN_SECRET` | HMAC key verifying tokens minted by Railway's `/api/v1/rooms/{id}/sfu-join` — must match Railway's `SFU_JOIN_SECRET` byte-for-byte |
| `SFU_ID` | `1` (single-box deployment) |
| `TURN_SECRET` | coturn's `static-auth-secret`, rendered into `turnserver.conf` by `deploy.sh` — must match Railway's `TURN_SECRET` byte-for-byte |
| `RUST_LOG` | `info` |

`apps/sfu/turnserver.conf` is **generated**, not committed — `deploy.sh`
renders it from `turnserver.conf.template` with the real `TURN_SECRET`
substituted in, then `chmod 644`s it. That permission is required, not
sloppy: coturn's official image runs as uid 65534 (`nobody`), which can't
read a root-owned `600` file — it silently falls back to defaults instead
of erroring on that, which is what made this worth documenting here after
hitting it during the first deploy.

Railway (`bettrcomms` service) needs the matching values — see the
"Railway side" section below.

## Health and observability

- `GET https://sfu.bettrcomms.com/health` — liveness + readiness +
  telemetry snapshot in one call. No auth (only non-sensitive counts).
- `GET /liveness`, `GET /readiness` — split semantics, for anything that
  wants to distinguish "process is up" from "accepting sessions" (in this
  single-process deployment they're equivalent by construction: the HTTP
  server never starts until the UDP socket is already bound).
- `GET /metrics` — JSON: `active_rooms`, `active_peers`,
  `peers_per_room`, `uptime_seconds`. Not Prometheus-formatted (deliberate
  — see `apps/sfu/src/telemetry.rs`); scrape/poll it if centralized
  monitoring is added later.
- Structured JSON logs to stdout (`docker logs bettrcomms-sfu-sfu-1`),
  capped at 10MB × 3 files per container (`docker-compose.yml`
  `logging.options`) so logs can't fill the 25GB disk unattended.

## Deploying a change

```sh
# from a machine with SSH access to the box:
rsync -az --exclude target --exclude .git apps/sfu/ root@74.207.235.154:/opt/bettrcomms-sfu/
ssh root@74.207.235.154 'cd /opt/bettrcomms-sfu && ./deploy.sh'
```

`deploy.sh` refuses to run if `.env` is missing or still holds the
`.env.example` placeholder secrets — it renders `turnserver.conf`, rebuilds
only the `sfu` image, and restarts the stack. Building the full dependency
tree from scratch takes ~4 minutes on this box's single vCPU (with the
swapfile in place); incremental rebuilds after a small source change are
seconds, since Docker layer-caches the dependency compile separately from
`src/`.

## Restart / upgrade / recovery

- Automatic restart: `restart: unless-stopped` on all three containers,
  Docker enabled at boot — verified by an actual `reboot` of the box
  during this deployment; the full stack (including a fresh Let's Encrypt
  handshake check by Caddy) was healthy again within ~7 seconds of the box
  coming back, no manual steps.
- Manual restart: `docker compose restart` (or `restart sfu` /
  `restart caddy` / `restart coturn` individually) from
  `/opt/bettrcomms-sfu`.
- Logs: `docker logs bettrcomms-sfu-<sfu|caddy|coturn>-1 [-f] [--tail N]`.
- Cert renewal: automatic (Caddy renews well before the Let's Encrypt
  90-day expiry; no cron/manual step).

## Troubleshooting

- **`/health` times out from outside but works via SSH loopback**: check
  both firewalls (`ufw status` on the box, and the Linode Cloud Firewall
  `btr` via the Linode console/API) — a rule missing from either blocks
  external traffic even if the other allows it.
- **coturn logs `Address already in use` on `127.0.0.1:3478`**: this is
  the permission bug above recurring — `turnserver.conf` isn't readable by
  uid 65534, so coturn silently used its built-in default port (3478,
  colliding with the SFU) instead of the configured 3479. Fix:
  `chmod 644 /opt/bettrcomms-sfu/turnserver.conf` and
  `docker compose restart coturn`.
- **Clients can't reach the SFU media path from a restrictive network**:
  confirm `TURN_URLS`/`TURN_SECRET` are actually set on the Railway side
  (see below) — without them, `/api/v1/ice` never advertises a TURN
  server and there is no fallback for that class of network.
- **Out of memory during a manual `docker compose build`**: confirm the
  swapfile is present (`swapon --show`); if it was somehow removed, redo
  the `fallocate`/`mkswap`/`swapon`/`fstab` steps documented in this repo's
  deployment history before rebuilding.

## Railway side

Railway's `bettrcomms` service needs these variables set to the exact
values configured in the SFU's own `.env` above (**not applied yet as of
this writing** — see the implementation report for why):

```
SFU_URL=wss://sfu.bettrcomms.com/ws
SFU_JOIN_SECRET=<same value as the SFU's .env>
TURN_URLS=turn:sfu.bettrcomms.com:3479
TURN_SECRET=<same value as the SFU's .env>
```

Setting these triggers a Railway redeploy of the `bettrcomms` service,
which drops active signaling/call sessions (documented, pre-existing
behavior of the single-replica deployment — see
[DEPLOYMENT.md](DEPLOYMENT.md)). Do this at a moment that's fine to
interrupt live calls, or announce it first.

## Known limitations

- **TURN relay range is small on purpose** (40 ports): fine for occasional
  restrictive-NAT fallback, not for many concurrent TURN-relayed sessions.
  Widen `min-port`/`max-port` in `turnserver.conf.template` and the two
  firewalls together if usage grows past that.
- **Single SFU, single box, single replica**: no horizontal scaling,
  capacity-aware placement, or multi-region routing. `SfuId` in the wire
  protocol exists for when this grows past one instance, but nothing here
  implements picking between several yet.
- **No load test performed yet against this box** (1 publisher → N
  subscribers at realistic bitrates) — the deployment is verified for
  correctness (join/leave, real ICE/DTLS/SRTP session establishment,
  cross-language token verification, TLS, reboot survival), not yet for
  capacity under load. See the implementation report for what's actually
  been tested versus what's still open.
