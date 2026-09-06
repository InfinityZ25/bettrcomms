# BetterComms product and technical specification

Status: implementation target, September 2026. “Required” describes the intended product, not the current repository state. Native media support is experimental until it meets the gates in `TEST_PLAN.md`.

## Product promise

BetterComms is a central place to talk with friends and persistent communities while playing, watching, and sharing. Text and presence must feel immediate; joining voice must be one action; media must preserve fidelity when the network and hardware allow it without making ordinary hardware unreliable.

The browser is the reference client. Windows desktop follows as a Tauri 2 shell with a narrowly scoped native media adapter. macOS and Linux follow only after the Windows contract is stable.

## Information architecture

The primary rail contains Home/Friends, direct conversations, and communities. A community owns roles, members, and ordered channels. Channel types initially include text and voice; a voice channel has a durable identity but an ephemeral call session. Direct conversations are first-class and may be one-to-one or group DMs. Search spans content the current user is authorized to read.

The conversation column contains message history, composer, replies, reactions, attachments, edit history markers, and unread boundaries. Presence has online, idle, do-not-disturb, and offline states. Read state is per user and per conversation. Blocking prevents new direct contact and suppresses presence; community moderation remains role-controlled.

Core entities are `User`, `Friendship`, `DirectConversation`, `Community`, `CommunityMember`, `Role`, `Channel`, `Message`, `Attachment`, `ReadCursor`, `CallSession`, `CallParticipant`, and `DeviceSession`. Stable UUIDs are generated server-side. Every mutable row has created/updated timestamps; destructive moderation and permission changes produce audit events.

## System architecture

The web client uses React, TypeScript, Vite, and shadcn/ui. State is split between server state (query cache), durable client preferences, and transient call state. The Go API owns authorization, persistence, signaling, presence fanout, and TURN credentials. PostgreSQL is authoritative. WorkOS supplies authentication; the API validates issuer, audience, signature, expiry, and organization context where applicable, then maps the external subject to an internal user.

HTTP handles resource reads/writes and resumable history pagination. A single authenticated WebSocket carries signaling, presence, typing, message events, membership changes, and read cursors. Every event has an ID and conversation sequence where ordering matters. Clients resume from the last acknowledged event and reconcile through HTTP after a gap. Idempotency keys protect message sends and other retried writes.

Tenant authorization is checked in Go for every request and subscription. Community/channel role resolution is explicit and testable; the client never decides access. PostgreSQL row constraints and indexed foreign keys preserve ownership and deletion rules. Attachments use short-lived signed object-store URLs; secrets, raw auth tokens, and media payloads are not logged.

## Calls and transport

WebRTC is direct-first. ICE gathers host, server-reflexive (STUN), and relay (TURN) candidates. “Direct-only” is an optional privacy/control setting that filters relay candidates and clearly warns that calls may fail across restrictive NATs. Normal mode falls back to TURN when direct connectivity fails. TURN credentials are short-lived and bound to the authenticated user/session. The signaling service never treats SDP as authorization: membership is checked before offer, answer, or ICE forwarding.

Group calls begin with a small-peer mesh only for an explicitly measured initial limit; an SFU is required before raising that limit. A generic server voice relay is not a hidden fallback. If an optional voice relay is introduced, it must be user-visible, encrypted in transit, separately deployable, and governed by retention and region policy.

Audio uses Opus. Profiles are: Voice (`mono`, DTX, conservative bitrate), Full-band (`stereo where source warrants`, music mode, higher bitrate), and Adaptive (default, network-responsive). Exact browser constraints are hints and negotiated results must be inspected. Echo cancellation, automatic gain control, and standard noise suppression are user-selectable with safe defaults. Per-participant volume is local-only and uses a client gain node. Optional loudness normalization estimates a bounded rolling level and changes gain slowly to avoid pumping; clipping protection is mandatory.

Standard denoise targets WebRTC audio processing and RNNoise where the implementation can prove latency and CPU budgets. NVIDIA Audio Effects is an optional native SDK integration, with an app-private runtime/model download rather than a dependency on the Broadcast application or its virtual microphone. Readiness requires loading the model and processing an audio frame on the actual GPU. The outgoing microphone passes through the native effect before WebRTC encoding; bounded buffering and explicit RNNoise fallback keep runtime failures visible. Krisp remains planned. Preserve the selected runtime's licenses and distribution requirements. No UI may imply these integrations work until runtime validation succeeds.

Video prefers hardware encode/decode when the runtime exposes it, then degrades resolution, frame rate, and finally video availability before harming audio. Capability decisions use actual codec negotiation and runtime stats, not GPU-name guessing. High-fidelity modes expose 1080p60 and higher bitrates only after device, encoder, uplink, and receiver checks. AV1/VP9/H.264 choices are based on mutual support and measured performance.

## Stage and media layout

The stage places the active camera strip at the top and content below it. The strip wraps or scrolls without covering shared content. Users can resize the strip and content split, collapse the strip, pop out a feed, pin any source, and restore a sensible automatic layout. Shared content supports fit, fill, 100%, zoom controls, wheel/pinch zoom, and pan while zoomed. Transform state is per viewer and never affects what others see. Keyboard focus, visible labels, reduced motion, and touch targets are required.

The layout engine preserves the content aspect ratio and prevents zero-sized panes. Double-click resets fit; Esc exits focused/fullscreen content. When the window narrows, camera tiles reduce before the content viewport. Active-speaker changes do not steal a manual pin.

## Capture, recording, and rewind

Browser capture uses `getUserMedia` and `getDisplayMedia`. The initial native Windows goal is game-only video capture plus audio from the selected game process and its child process tree. Selection is explicit and revocable. Protected content, elevated processes, anti-cheat restrictions, exclusive fullscreen, and apps that opt out may be unavailable and must yield a specific reason. System-wide audio is not silently substituted for process audio.

The native adapter contract returns enumerated sources, capability state, a user-facing unavailability reason, and media handles/frames through a bounded bridge. It must support cancellation, device loss, process exit, backpressure, and privacy indicators. The current scaffold reports capability only; it does not enumerate sources or produce media.

Recording is local and explicit. Each inbound/outbound logical track is written independently in restartable segments. A monotonic session clock and manifest map each segment's track ID, participant, media kind, codec, wall-clock anchor, monotonic start/end, gaps, and integrity hash. A composite export is derived, never the sole recording. Consent indicators and applicable jurisdiction policy are product requirements.

Viewer-local rewind keeps a rolling, bounded, segmented buffer on the viewer's device. The viewer can seek recently received media without changing the live position for anyone else, then jump to live. Limits are configurable by duration and disk bytes. Old complete segments are evicted first; an atomic index survives crashes; low disk, logout, call end, or revoked permission stops and cleans according to policy. Buffers are encrypted at rest when retained beyond process lifetime and are never uploaded implicitly.

## Reliability, privacy, and observability

Audio join has the highest media priority. Reconnect preserves the text session, re-establishes signaling, restarts ICE when needed, and reports whether capture continued. Metrics include join success, time to first audio, ICE candidate pair type, relay rate, packet loss, jitter, round-trip time, freeze duration, encoder fallback, CPU pressure, and recording gaps. Metrics contain opaque IDs and coarse device classes; SDP, message text, filenames, and raw device labels are excluded.

Required security controls include least-privilege Tauri capabilities, CSP, dependency review, short-lived media credentials, rate limits, attachment scanning, abuse reporting, moderation audit logs, and account/session revocation. The desktop webview exposes no arbitrary shell or unrestricted filesystem API.

## Non-goals for the first release

The first release does not promise native capture on macOS/Linux, unlimited-size mesh calls, cloud recording, server-side rewind, transparent DRM capture, guaranteed capture of protected/elevated games, or bundled NVIDIA/Krisp processing.

## Success measures

Release decisions use measured outcomes: message delivery p95 under 500 ms within a region; voice join p95 under 3 seconds on the reference network set; two-party call establishment above 99% with TURN enabled; zero unauthorized channel/event delivery in access-control tests; audio gap rate and crash-free session targets set from beta telemetry; and successful bounded-buffer eviction/recovery under the test plan.
