# Bettercomms server protocol (v1)

All API responses are JSON. Errors use `{ "error": { "code": "...", "message": "..." } }`.
Mutating requests require `Content-Type: application/json`, except avatar/attachment uploads, which use multipart form data. Authentication uses an opaque, `HttpOnly`, `SameSite=Lax` session cookie whose SHA-256 hash and expiry are stored in PostgreSQL. Production sessions are issued only after a WorkOS OAuth callback. `DEV_AUTH=true` enables `POST /api/v1/auth/dev` only when the request host and remote address are loopback.

Browser mutation origins must match `APP_URL`; requests marked cross-site are rejected. Native clients without an `Origin` header authenticate through the same cookie contract. WebSocket handshakes accept configured local application origins and still require room membership.

## Authentication

- `GET /api/v1/auth/login?return_to=/` redirects to WorkOS AuthKit.
- `GET /api/v1/auth/callback?code=...&state=...` exchanges the code server-side and sets the session cookie. When the state belongs to a desktop pairing it sets no cookie: it records the user against the pairing and redirects to `/api/v1/auth/desktop/done`.
- `POST /api/v1/auth/dev` with `{ "email": "alice@example.test", "name": "Alice" }` creates/signs in a local test user when localhost-only development auth is enabled.
- `GET /api/v1/me` returns the signed-in user.
- `POST /api/v1/auth/logout` clears the session.
- `GET /api/v1/config` is public and returns `{ "dev_auth": boolean, "ice_servers": [{ "urls": [...] }] }`; it never returns ICE credentials or server secrets.
- `GET /api/v1/ice` is authenticated and returns STUN plus short-lived coturn REST credentials as `{ "ice_servers": [...], "ttl_seconds": 600 }`.
- `GET /api/v1/users?q=alice` searches users by email, display name or username for friend discovery.

### Profile and account presence

- `PATCH /api/v1/me` accepts any of `{name,username,bio}` and returns `{user}`. Names are trimmed, 1–80 characters. Usernames are normalized to lowercase and use 3–32 ASCII letters, digits or underscores; duplicate names return `409 username_taken`. Bios allow 160 characters. An edited profile survives later identity-provider and development sign-ins. Each explicit profile/avatar mutation increments `user.profile_version`; clients discard lower-version mutation responses/events so concurrent device edits cannot restore a stale profile.
- `POST /api/v1/me/avatar` accepts multipart `file`, a PNG/JPEG up to 256 KiB and four million decoded pixels. The server crops/scales to at most 256×256 and re-encodes PNG, discarding source metadata. `{user}` contains a versioned relative `/api/v1/users/{id}/avatar?version=N` URL; no arbitrary upload URL or data URI is accepted. `DELETE /api/v1/me/avatar` removes the image and returns `{user}`. Explicit removal survives provider refreshes.
- `GET /api/v1/users/{id}/avatar` requires authentication plus own-account, friend/request, or authorized shared-room access, with blocks respected. This binary PNG endpoint has `Cache-Control: no-store`; clients may retain bounded, account-scoped blob caches and must release them at logout/version change.
- `GET /api/v1/me/presence` returns `{status}`. `PUT` accepts `{status: "online"|"idle"|"dnd"|"invisible"}`. This is a manual account preference persisted across devices; it does not poll other applications. Account DND clears queued push and prevents new push, regardless of device subscription settings. Message history and realtime synchronization continue during DND.
- Effective contact presence aggregates all event sockets: the last disconnect becomes `offline`; invisible appears offline to contacts. The desired preference is disclosed only to the account's own devices, not in public user payloads. Closing one of several connected windows does not mark the account offline.

### Desktop sign-in hand-off

A packaged desktop client cannot host the provider's UI in its own webview, so it runs the flow in the system browser and claims the result over a pairing. The client keeps a secret verifier and sends only its digest; the pairing id, which is the only part that travels through the browser, cannot claim anything on its own.

- `POST /api/v1/auth/desktop/start` with `{ "verifier_hash": "<base64url SHA-256>" }` returns `201` and `{ "pairing_id", "code", "confirm_path", "expires_in", "poll_interval" }`. `confirm_path` is relative: the client supplies the origin, so a server cannot choose which page a desktop app opens.
- `GET /api/v1/auth/desktop/confirm?pairing=<id>` renders a script-free page showing `code`. The person compares it with the code their desktop window is displaying and submits the form, which `POST`s to the same path and redirects on to `/api/v1/auth/login?desktop=<id>`. Nothing reaches the provider before this: without the step, a link to someone else's pairing would sign whoever follows it into that other person's application.
- `GET /api/v1/auth/login?desktop=<id>` refuses an unconfirmed, expired, or already-completed pairing.
- `POST /api/v1/auth/desktop/claim` with `{ "pairing_id", "verifier" }` returns `202 { "status": "pending" }` until the browser has finished, then `200 { "status": "complete", "user": {...} }` with the session cookie. A wrong verifier is `403` and leaves the pairing intact for its real owner; an unknown, expired, or already-claimed pairing is `404`. A pairing is spent by its first successful claim and lives at most ten minutes.

## Rooms and chat

- `GET /api/v1/rooms` lists rooms the caller belongs to.
- `POST /api/v1/rooms` with `{ "name": "Friday night" }` creates a room and makes the caller its owner.
- `POST /api/v1/rooms/direct` with `{ "user_id": "..." }` returns an idempotent direct-message room for an accepted friend pair.
- `POST /api/v1/rooms/group` with `{ "name": "Friends", "user_ids": ["..."] }` creates a private group DM with one to nine invited friends and the creator (ten people maximum). The creator must be friends with each invitee and no pair may have a block. Group identity is separate from two-person direct-room keys.
- `GET /api/v1/rooms/{room_id}` returns a room to members only.
- `PATCH /api/v1/rooms/{room_id}` with `{ "name": "..." }` renames a channel or group DM; owner only.
- `DELETE /api/v1/rooms/{room_id}` deletes a room; owner only.
- `GET /api/v1/rooms/{room_id}/members` returns `{ "members": [{ "user": {...}, "role": "owner|member", "joined_at": "..." }] }` to room members only.
- `POST /api/v1/rooms/{room_id}/members` with `{ "user_id": "..." }` adds an accepted friend; owner only.
- `DELETE /api/v1/rooms/{room_id}/members/{user_id}` removes a member; the owner may remove members and a member may remove themself. Channel owners must delete their room instead. Group owners may leave; ownership transfers to the earliest joined remaining member, breaking ties by UUID. An empty group is deleted. Blocking someone automatically leaves any shared group DMs, transfers ownership if needed, and evicts the blocker from live subscriptions/calls. Friend removal alone does not undo an explicit group invitation.
- `GET /api/v1/rooms/{room_id}/messages?before=<RFC3339>&limit=50` returns newest messages in ascending presentation order.
- `POST /api/v1/rooms/{room_id}/messages` with `{ "body": "..." }` persists and broadcasts a chat message.

### Channel invitation links

Channel owners manage these links; direct and group DMs use their own invitation rules.

- `GET /api/v1/rooms/{id}/invites` returns `{invites:[{id,room_id,created_at,expires_at,max_uses,uses,revoked_at}]}` with active links first, then history, up to 100 records. Tokens are never included in the list. Each room permits at most 20 active links; atomic creation returns `409 invite_limit` until one is revoked, exhausted or expired. Historical links cannot hide a still-active link from revocation.
- `POST /api/v1/rooms/{id}/invites` accepts optional `{expires_in_seconds,max_uses}`. Defaults are seven days and 100 uses; zero means unlimited. Maximums are 30 days and 1000 uses. Returns `201 {invite,token,url}` once, where `url` uses the configured application origin and `#/?invite=<token>` fragment. The 256-bit random token is stored only as SHA-256.
- `DELETE /api/v1/rooms/{id}/invites/{invite_id}` revokes the link. Removing the room also deletes its links.
- `GET /api/v1/invites/{token}` requires sign-in and returns minimal `{invite:{room_id,room_name,expires_at,remaining_uses,already_member}}`; unlimited remaining uses are `null`. It exposes no roster/history. Expired, revoked or exhausted links return `404 invite_unavailable`. A member can preview an exhausted link while it remains unrevoked/unexpired.
- `POST /api/v1/invites/{token}/join` returns `{room}`. A successful new membership consumes one use atomically; simultaneous joins cannot overspend a use limit and repeat joins by an existing member consume none. A block between the owner and joining user prevents redemption. This grants channel membership without creating a friendship.
- The app must retain a pending invitation locally through sign-in, ask the authenticated person to join, and remove the token from the address bar after handling it. Do not log tokens or put them in query strings/referrers.

## App-wide realtime stream

`GET /api/v1/events` retains the existing authenticated socket and room-derived subscriptions. `app.ready` includes existing call `presence` and `online_user_ids`, plus `contact_presence: [{user_id,online,status}]` and `own_presence:{status}`. Contact status is effective `online|idle|dnd|offline`; own status also allows `invisible`.

`user.presence` has `{user_id,online,status}` and includes `desired_status` only for the user's own sockets. `user.profile` carries `{user}` to authorized subscribed contacts, room members and all own sockets after a committed edit; public user objects omit `presence_status`. Clients invalidate/update profile, friendship and room-member caches without additional presence polling. Room membership changes keep using `rooms.changed`.

Within the current single API process, realtime/call socket ACL snapshots, registration and their bounded initial write share a registration boundary with membership/contact mutations through their live revocation. A removal cannot complete and then be undone by an older handshake registering stale subscriptions. Body upload occurs before acquiring this boundary. Message/media processing has no per-event authorization polling or global membership lock.

## Friends

- `GET /api/v1/friends` lists accepted friends and pending requests.
- `POST /api/v1/friends/requests` with `{ "user_id": "..." }` creates a request.
- `POST /api/v1/friends/requests/{request_id}/accept` accepts an incoming request.
- `DELETE /api/v1/friends/{user_id}` removes a friendship or request involving the caller.

## WebSocket signaling

`GET /api/v1/rooms/{room_id}/ws?peer_id=<uuid>&join_mode=replace|additional` upgrades only for authenticated room members. The session cookie authenticates the account while the random `peer_id` identifies this device's call endpoint. `replace` closes the account's other endpoints in this room; `additional` keeps them connected. Messages are bounded to 64 KiB.

Client frames:

```json
{ "type": "offer", "to": "device-peer-id", "description": { "type": "offer", "sdp": "..." } }
{ "type": "answer", "to": "user-id", "description": { "type": "answer", "sdp": "..." } }
{ "type": "ice-candidate", "to": "user-id", "candidate": { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 } }
{ "type": "track-metadata", "to": "user-id", "tracks": [{ "source": "camera|screen|microphone|system", "trackId": "...", "streamId": "optional", "mediaKind": "audio|video", "enabled": true }] }
{ "type": "presence", "payload": { "camera": true, "microphone": true, "sharing": false } }
{ "type": "ping", "request_id": "optional" }
```

Server frames:

```json
{ "type": "signal", "from": "user-id", "request_id": "optional", "payload": {} }
{ "type": "peers", "payload": { "peers": ["device-peer-id"], "identities": { "device-peer-id": { "user_id": "account-id", "name": "Alice" } } } }
{ "type": "presence", "from": "device-peer-id", "user_id": "account-id", "payload": {} }
{ "type": "peer.joined|peer.left", "from": "device-peer-id", "user_id": "account-id", "name": "Alice" }
{ "type": "pong", "request_id": "optional" }
{ "type": "error", "error": { "code": "...", "message": "..." } }
```

`offer`, `answer`, `ice-candidate`, and `track-metadata` are relayed unchanged except that the server supplies the authenticated device peer as `from`. A legacy `signal` envelope is also accepted. Signals are ephemeral and relayed only to a currently connected target in the same room. Presence is ephemeral, grouped by account for room rosters, and includes `device_count`; media routing remains per device. Messages, membership, and friendships are persisted in PostgreSQL. Older clients that omit `peer_id` retain the single-device replacement behavior.

In v1, a `channel` room is the conversation container that future community/server channels will reference. Communities themselves are outside the current protocol. A `direct` room is a persistent, unique conversation for one authorized pair. A `group` room is a private conversation with explicit owner-managed invitations and at most ten people.

Successful REST envelopes use the resource name: `{ "user": ... }`, `{ "users": [...] }`, `{ "room": ... }`, `{ "rooms": [...] }`, `{ "message": ... }`, `{ "messages": [...] }`, `{ "request": ... }`, or `{ "friends": [...], "requests": [...] }`. Action-only responses use `{ "ok": true }`.

## Moderation and account lifecycle

Channel owners configure `PUT /rooms/{room}/moderation/slow-mode`, `PUT|DELETE /rooms/{room}/moderation/timeouts/{user}` and `PUT|DELETE /rooms/{room}/moderation/bans/{user}`. `GET /rooms/{room}/moderation` returns the caller's posting state; owners also receive ban pages of 50 and the latest 100 audit entries. Follow `bans_next` using `?bans_after={cursor}`. Restrictions and cooldowns return HTTP 429 with `posting_restricted` or `slow_mode` and `Retry-After`; new messages, edits, reactions and uploads enforce the appropriate rule on the server. A `room.moderation` event invalidates posting state. See [moderation semantics](../docs/MODERATION.md).

`GET /me/sessions`, `DELETE /me/sessions/{public-id}` and `POST /me/sessions/revoke-others` expose only the caller's device sessions. Session IDs are public identifiers, not credentials. Revocation closes that session's event, signaling, voice relay and SFU authorization sockets. `POST /rooms/{room}/ownership` transfers a channel to an existing member. `DELETE /me/account` requires an exact email and `DELETE` confirmation and rejects accounts that still own channels. Deletion tombstones identity, removes personal content and revokes all sessions. See [deletion limits and device handling](../docs/ACCOUNT_SESSIONS.md).

`GET /rooms/{room}/sfu-join?peer_id={active-device-peer}` signs claims bound to a public session ID and the caller's own active signaling peer. The SFU authenticates a live `GET /sfu/authorization` WebSocket using its signed bearer token; it receives `{ "authorized": true }` before admitting media and exchanges text `ping` / `pong` heartbeats. Duplicate active peer leases are rejected; a revoked/expired session or lost lease ends media. Configure the trusted API endpoint via `BETTERCOMMS_API_URL` or `SFU_AUTH_URL` on the SFU. API and SFU authorization state is local to one API process; multi-instance routing/revocation requires a shared coordination layer before deployment.
