# Channel moderation

Channel owners can configure slow mode, temporarily restrict a member from posting, or ban and unban a member in Room settings. Direct and group conversations do not gain moderator roles.

- Slow mode defaults to off and accepts 0–3600 seconds. It limits new messages, including thread replies, per member across the channel. Edits, reactions and deleting one's own message remain available. An idempotent retry does not consume another interval.
- A posting restriction lasts 1 second to 28 days. It prevents new messages, edits, reactions, uploads and typing indicators. Reading, calls and deleting one's own messages remain available. Expiration is checked against the database clock, with no worker required.
- A ban removes membership, revokes live room signaling, voice relay and SFU authorization, and prevents invitations from restoring access. Unbanning permits a subsequent invitation; it does not automatically restore membership.
- Owners are exempt from slow mode and cannot ban or restrict themselves. Moderation actions require the current channel owner, are committed transactionally and are recorded in a bounded recent audit view.

The composer shows an expiry or cooldown without polling. Server checks are authoritative: concurrent sends serialize on membership, and room access changes serialize with socket admission. Disabled send/upload controls do not discard a draft.

REST paths live below `/api/v1/rooms/{room}/moderation`:

| Method and path | Payload / result |
| --- | --- |
| `GET /` | Own posting state; owners also receive current bans and recent audit |
| `PUT /slow-mode` | `{ "seconds": 30 }` |
| `PUT /timeouts/{user}` | `{ "seconds": 600, "reason": "Repeated spam" }` |
| `DELETE /timeouts/{user}` | Clear the restriction |
| `PUT /bans/{user}` | `{ "reason": "Repeated spam" }` |
| `DELETE /bans/{user}` | Remove the ban |

Restricted writes return HTTP 429 with `posting_restricted` or `slow_mode` and `Retry-After`. A `room.moderation` event prompts clients to refresh posting state. Audit history is retained when an account becomes a tombstone.

Ban lists use pages of 50 members. `GET /?bans_after={bans_next}` loads the next page; an empty `bans_next` ends the list. The UI offers Load more so older active bans remain manageable. The recent audit view returns the latest 100 actions.

Integration tests cover owner permissions, durations, concurrent cooldown enforcement, nonce retries, timeout expiration, edits/reactions/uploads, deletion, ban/rejoin and audit records. Browser tests use the real local API and synthetic media; they do not establish native capture or external-network acceptance.
