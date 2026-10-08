# Channel activities

Open **Activities** beside a channel's composer for Polls, Events, Watch together,
Stickers and Soundboard. The browser remains the reference client. Activities use
the same authenticated API, PostgreSQL database and current channel permissions
as chat; they do not create a second chat or separate voice channel.

## Polls and events

Polls have 2–10 different choices and one replaceable vote per member. Votes can
be withdrawn while open. The author or a moderator can end a poll; an optional
deadline closes voting at the server, including requests racing the deadline.
Results disclose counts and the viewer's own choice, without publishing voter
identities. Read permission permits voting; posting permission permits creation.

Scheduled events use a future date within one year and a local-time browser input
that is stored as UTC. Members choose Going, Maybe or Can't make it. The creator
starts as Going. The author or a moderator can cancel an event.

The authenticated shell checks reminders every minute and on reconnect or event
changes. Going and Maybe generate a durable inbox reminder from ten minutes
before the start, including offline catch-up up to one day after the start. A
unique event/member key prevents duplicate reminders; dismissal remains persisted
across refreshes. Cancelled, declined and inaccessible events disappear from the
inbox. This is an in-app inbox; it does not promise an event Web Push notification
while the application is closed.

## Watch together

Choose a video already published in the channel's file library. The API accepts
attachment IDs and resolves their private URLs with the same authorization as
ordinary downloads. Arbitrary external embeds are not accepted. Every viewer
explicitly starts local playback; local mute, volume and playback permission do
not affect another viewer or change recorded tracks.

The server owns the paused state, position anchor, update timestamp, host and
monotonically increasing revision. Host Play, Pause and Seek commands require the
current revision. Clients reconcile authenticated events with HTTP and use the
server timestamp plus a local monotonic clock to follow playback, correcting
drift over 750 ms. A new command revision applies its exact playback position,
including seeks smaller than that drift threshold. Closing a player releases its
media element and timers.

The host can explicitly transfer control to another permitted member. A player
refreshes its host lease every fifteen seconds. After sixty seconds without a
heartbeat, or immediately after the host loses posting/voice access, another
permitted member can take over. Reload restores the persisted session and requires
the viewer to enable playback again. Read or voice permission revocation removes
the player from the activity snapshot.

## Stickers and soundboard

Each channel supports up to 100 custom stickers and 100 sounds. Stickers are
passive images up to 5 MiB; sounds are audio up to 2 MiB and 30 seconds. Uploads use
the ordinary private attachment pipeline, including its configured scanning and
quota rules. Asset references retain the original object and prevent draft
cleanup from deleting a reusable asset. The creator or a moderator can remove
an asset, revoking its private preview and removing reusable message references.

Sending a sticker atomically creates a normal message with a reusable asset
reference. An idempotency nonce prevents duplicate sends after an interrupted
response. The source object is counted once and is not duplicated or assigned
the same object key to multiple independently deletable attachment rows.

Soundboard Play requires current voice membership and voice permission. The API
limits each user to four plays per ten seconds and each channel to thirty plays
per minute. Playback is opt-in, deduplicates event IDs and ignores stale events.
Only the viewer's active voice call subscribes to local sound output. Soundboard
volume and mute are independent of microphone processing and recording sources;
Deafen stops every active/pending sound. Each player releases URLs, timers and
requests on leave, deafen, disconnect or account unmount. Declared duration and a
thirty-second upper bound prevent files from producing unbounded sound output.

## Edit history

PostgreSQL captures the original and each changed text version inside the message
edit transaction. The edited marker opens a member-authorized history dialog.
Message deletion and moderation erase retained text versions in the same database
transaction. Edits predating migration 019 have no recoverable prior text.

## Acceptance coverage

`channel_activities_test.go` covers unique votes, closed polls, outsider denial,
RSVP cancellation, durable reminder deduplication/dismissal, history erasure,
reusable sticker authorization/idempotency, stale playback revisions, host
transfer, and immediate host takeover after voice-only ACL revocation.

`features/activities/*.test.ts` covers monotonic playback anchors, deadlines,
event validation/isolation, StrictMode mount cancellation and private-state
removal after a forbidden reconciliation. `tests/channel-activities.spec.ts`
exercises the corresponding browser flows against the real API/database/S3
storage with synthetic media. These browser tests do not establish native device
capture, hardware encoding or cross-network call connectivity.

The optimized browser suite also checks private PDF canvas pages in Chromium and
WebKit, and decodes the actual clip export in Chromium. Clip cases probe the real
stream, recorder, AudioContext and canvas-capture APIs first: WebKit builds that
omit these bindings report an explicit unsupported skip; capable builds run the
same encoding and cleanup assertions.
