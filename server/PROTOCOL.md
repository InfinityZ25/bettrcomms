# Bettercomms server protocol (v1)

All API responses are JSON. Errors use `{ "error": { "code": "...", "message": "..." } }`.
Mutating requests require `Content-Type: application/json`. Authentication uses an opaque, `HttpOnly`, `SameSite=Lax` session cookie whose SHA-256 hash and expiry are stored in PostgreSQL. Production sessions are issued only after a WorkOS OAuth callback. `DEV_AUTH=true` enables `POST /api/v1/auth/dev` only when the request host and remote address are loopback.

Browser mutation origins must match `APP_URL`; requests marked cross-site are rejected. Native clients without an `Origin` header authenticate through the same cookie contract. WebSocket handshakes accept configured local application origins and still require room membership.

## Authentication

- `GET /api/v1/auth/login?return_to=/` redirects to WorkOS AuthKit.
- `GET /api/v1/auth/callback?code=...&state=...` exchanges the code server-side and sets the session cookie.
- `POST /api/v1/auth/dev` with `{ "email": "alice@example.test", "name": "Alice" }` creates/signs in a local test user when localhost-only development auth is enabled.
- `GET /api/v1/me` returns the signed-in user.
- `POST /api/v1/auth/logout` clears the session.
- `GET /api/v1/config` is public and returns `{ "dev_auth": boolean, "ice_servers": [{ "urls": [...] }] }`; it never returns ICE credentials or server secrets.
- `GET /api/v1/ice` is authenticated and returns STUN plus short-lived coturn REST credentials as `{ "ice_servers": [...], "ttl_seconds": 600 }`.
- `GET /api/v1/users?q=alice` searches users by email or display name for friend discovery.

## Rooms and chat

- `GET /api/v1/rooms` lists rooms the caller belongs to.
- `POST /api/v1/rooms` with `{ "name": "Friday night" }` creates a room and makes the caller its owner.
- `POST /api/v1/rooms/direct` with `{ "user_id": "..." }` returns an idempotent direct-message room for an accepted friend pair.
- `GET /api/v1/rooms/{room_id}` returns a room to members only.
- `PATCH /api/v1/rooms/{room_id}` with `{ "name": "..." }` renames a channel; owner only.
- `DELETE /api/v1/rooms/{room_id}` deletes a room; owner only.
- `GET /api/v1/rooms/{room_id}/members` returns `{ "members": [{ "user": {...}, "role": "owner|member", "joined_at": "..." }] }` to room members only.
- `POST /api/v1/rooms/{room_id}/members` with `{ "user_id": "..." }` adds an accepted friend; owner only.
- `DELETE /api/v1/rooms/{room_id}/members/{user_id}` removes a member; the owner may remove members and a member may remove themself. The owner cannot be removed without deleting the room.
- `GET /api/v1/rooms/{room_id}/messages?before=<RFC3339>&limit=50` returns newest messages in ascending presentation order.
- `POST /api/v1/rooms/{room_id}/messages` with `{ "body": "..." }` persists and broadcasts a chat message.

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

In v1, a `channel` room is the conversation container that future community/server channels will reference. Communities themselves are outside the current protocol. A `direct` room is a persistent, unique conversation for one accepted friend pair.

Successful REST envelopes use the resource name: `{ "user": ... }`, `{ "users": [...] }`, `{ "room": ... }`, `{ "rooms": [...] }`, `{ "message": ... }`, `{ "messages": [...] }`, `{ "request": ... }`, or `{ "friends": [...], "requests": [...] }`. Action-only responses use `{ "ok": true }`.
