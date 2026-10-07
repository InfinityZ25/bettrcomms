# Rooms and unified channels

The product calls a persistent community a **room**. Its child channels keep the
existing `/rooms/{channelId}` message, attachment and call paths for compatibility.
Opening a channel shows its chat; Join voice uses the same channel ID. There is no
second chat attached to a separate voice channel. Announcements disable all voice
admission and permit posting only by the room's owner/admins. Changing a hybrid
channel to announcements disconnects its active media participants.

Migration `016_communities_channels_roles.sql` creates a parent for each legacy
channel without changing channel UUIDs, read cursors or history. Parent membership
is authoritative and mirrored into child membership for existing APIs. A room
must retain at least one channel. New rooms start with hybrid #general.

| Role | Room permissions |
| --- | --- |
| Owner | Manage the room/channels, admins and lower roles; transfer ownership; delete the room |
| Admin | Manage settings/channels and moderator/member roles below their rank; publish announcements |
| Moderator | Invite friends, remove/moderate members below their rank, manage pins and reports |
| Member | Read channels; chat and join voice in hybrid channels |

Only owners can assign admins. Nobody assigns the owner role through role updates
or changes their own role. Removal, bans and timeouts affect all sibling channels;
invitations join the parent room and cannot bypass bans. Ownership transfer is
explicit and leaves the previous owner as an admin. Custom roles and channel
permission overrides are not included in this batch.

REST resources live below `/api/v1`:

| Method/path | Behavior |
| --- | --- |
| `GET/POST /communities` | List joined rooms / create room with #general |
| `GET/PATCH/DELETE /communities/{id}` | Read, rename/describe, or delete room |
| `GET/POST /communities/{id}/members` | List members / add accepted friend |
| `DELETE /communities/{id}/members/{user}` | Remove lower-ranked member or leave |
| `PUT /communities/{id}/members/{user}/role` | Assign admin/moderator/member within hierarchy |
| `POST /communities/{id}/ownership` | Transfer ownership to an existing member |
| `POST /communities/{id}/channels` | Create hybrid/announcement channel |
| `PATCH/DELETE /communities/{id}/channels/{channel}` | Update or delete child channel |
| `POST /communities/{id}/channels/reorder` | Atomically reorder the full channel ID list |

Channel responses include parent metadata and resolved permissions. Clients use
those permissions for affordances; the Go API independently authorizes every
HTTP write and media subscription. Membership events refresh navigation through
the existing authenticated realtime stream.

The web production build, 489 Vitest tests, `go test ./...` with Docker PostgreSQL
integration and `go vet ./...` passed. Targeted real-API Chromium acceptance passed for shared room
roles, hybrid channels, announcement posting/voice denial and live revocation,
alongside the MinIO image/MP4 upload, preview, retry and original-download flow.
Automated results are recorded in
[PR #40](https://github.com/InfinityZ25/bettrcomms/pull/40). Release requires the
Chromium suite and the optimized-build Chromium/WebKit matrix, including share
zoom through transparent footer areas and centered fullscreen controls with an
open conversation pane.

Explicit Messages navigation now survives initial default-channel selection.
Returning to an active call after channel navigation reattaches camera layout
observation to its mounted stage and ignores callbacks from the previous stage.

Recording finalization now waits for the stop event and final data block after
the recorder becomes inactive. The browser matrix also covers WebKit startup
without `AudioWorkletNode`, with RNNoise/Speex imports deferred to their audio
paths.

The release matrix still covers migration with existing channels/DMs/groups, all
role pairs, ownership and account deletion, concurrent last-channel deletion,
sibling membership/media revocation, invitation redemption, announcement posting/
upload/typing/pins and media admission, and switching voice channels during an
active call. Cancelled joins must reject late completion and release their media
resources. The synthetic MP4 above 16 MiB does not establish 500 MiB production
transfers. See `TEST_PLAN.md` for validated coverage and the remaining deployment,
physical-device, native capture/encoding and cross-network acceptance boundaries.
