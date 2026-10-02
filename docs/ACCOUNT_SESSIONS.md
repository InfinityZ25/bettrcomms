# Account and device sessions

Settings → Account lists this account's active sessions with a public session ID, creation, expiration, last activity and a bounded device label. Labels distinguish Windows/macOS/Linux and common browsers; the native API proxy identifies BetterComms Desktop. Raw User-Agent values, cookies and token hashes are never returned. Activity timestamps update at most every five minutes.

Users can revoke one session or all other sessions. Current-session revocation signs out the client. A revoked session loses HTTP access and its event, signaling, voice relay and SFU authorization sockets; other sessions and other accounts stay connected. Socket admission and access-changing operations share a short synchronization boundary, excluding request-body and S3 transfers. Uploads revalidate their originating session before reservation and after S3 completion, retaining rejected object keys for cleanup.

| Endpoint below `/api/v1` | Behavior |
| --- | --- |
| `GET /me/sessions` | Active sessions belonging to the signed-in account |
| `DELETE /me/sessions/{public-id}` | Revoke that account's session |
| `POST /me/sessions/revoke-others` | Keep the current session and revoke the rest |
| `POST /rooms/{room}/ownership` | Transfer a channel to an existing member with `{ "user_id": "…" }` |
| `DELETE /me/account` | Require `{ "confirmation": "DELETE", "email": "current email" }` |

Account deletion first requires transferring or deleting every owned channel. The UI guides this before showing explicit confirmation. Deletion revokes all sessions, removes social/contact and notification associations and memberships, replaces the account identity with a tombstone, clears authored message content, and makes uploaded attachments unavailable. Shared channel history remains readable for other members. S3 object keys remain until asynchronous cleanup succeeds, including retries after storage failures. Previously issued S3 download URLs may remain usable for their five-minute lifetime. WorkOS organization administration and deleting an identity in WorkOS are separate operations; local deletion does not remove unrelated WorkOS users.

## Live SFU authorization

API and SFU must be deployed together for the session-aware join claims. A join token is short-lived and bound to the user, public session ID, room and exact active signaling peer. The SFU additionally holds an authorization WebSocket to the API for the entire media session. Revocation, expiry, API restart or a lost authorization connection tears down SFU media; the token alone cannot keep a call alive. Duplicate active peer registrations are rejected until the previous connection finishes cleanup.

Configure `BETTERCOMMS_API_URL` on the SFU, for example `https://api.example.test`. The SFU derives `wss://api.example.test/api/v1/sfu/authorization`; an explicit `SFU_AUTH_URL` can override it. The local default is `ws://127.0.0.1:8080/api/v1/sfu/authorization`. Use the API's `SFU_JOIN_SECRET` on both services. Never set a shared secret or session cookie in a `VITE_` variable. Admission fails closed with a diagnostic if the API endpoint cannot authorize the peer.

The authorization connection uses a 15-second application heartbeat and a 40-second watchdog, with five-second admission/write timeouts. There is no periodic database polling or per-packet authorization query. A stalled client signaling write still observes lease cancellation. Peer UUIDs are hashed before conversion to the SFU's numeric peer identity.

Integration tests cover account-scoped session listing, cross-account revocation denial, selective closure of live sockets, invalidated SFU authorization and irreversible account tombstoning. Rust tests cover authorization revocation, missing heartbeats, blocked writes and duplicate route protection. Packaged authentication, macOS capture parity and external-network media still require their existing acceptance gates.
