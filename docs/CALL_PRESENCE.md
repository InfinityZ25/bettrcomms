# Call presence and lobby

Room membership and call participation are different states. Opening a conversation must not capture media, join signaling, or show the viewer as a call participant. The lobby and conversation navigation show only authenticated participants with a live call connection. Direct conversations are grouped separately from rooms and use the other members' names for display.

Call presence belongs to the existing signaling process's memory, not PostgreSQL. Authenticated members receive an authorized initial snapshot and subsequent room-roster changes through the app-level `/api/v1/events` WebSocket; `/api/v1/call-presence` remains available as a compatibility snapshot endpoint. An open call sends validated mute/deafen state through its room signaling socket, and the server immediately fans the resulting grouped roster out to every authorized member observing the room. A failed event stream marks presence unavailable and reconnects with bounded backoff; the new snapshot reconciles anything missed while disconnected. Disconnect, connection replacement, membership revocation, and server restart remove ephemeral state.

Only shared-room activity is visible. A friendship does not authorize viewing unrelated private calls. The Friends view may identify a friend as participating in a shared call; it does not infer global online/offline status from call participation.

Deafen disables outgoing microphone audio and silences the call playback bus, including shared audio. Undeafen restores the prior microphone mute choice. It does not change saved input/output volume, per-person volume, or incoming source tracks used for recording. Recording playback and microphone settings tests have separate output paths.

## Why no decentralized database yet

These values are disposable session state, not durable records requiring replicated storage. Peer gossip would still need authenticated discovery, membership revocation, stale-state expiry, and a way for a lobby observer to discover currently connected peers. Forwarding friends-of-friends presence must not broaden authorization. Keeping a small authoritative ephemeral roster alongside signaling avoids those additional trust and connectivity paths without storing mute/deafen updates in the database.

This implementation retains the current single signaling-process deployment constraint. Multi-replica operation requires shared ephemeral presence and room routing, or an explicitly designed authenticated peer presence protocol. The account-level event subscription remains separate from the call socket so observing a room never enters the media mesh.
