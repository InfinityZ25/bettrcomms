# YouTube Watch Together

Watch Together supports private channel video files and YouTube videos/Shorts.
YouTube sessions are hidden from clients that do not advertise the
`watch_sources=file,youtube` capability. Existing file playback remains available.

YouTube playback in the macOS Wails app is intentionally unavailable: use
BetterComms in a browser. Shared file videos and private YouTube lists remain
available in that app. Windows desktop playback still requires real packaged
acceptance; its implementation and compilation do not establish native readiness.

Join Watch registers viewing explicitly without requesting a microphone. A
15-second heartbeat gives each device a 60-second lease. Counts and votes use
distinct accounts rather than tabs. Present readers with voice permission can
watch and vote; adding videos and controlling playback also require publication
permission. The host controls play, pause, seek, reordering, advancement and
transfer to a present eligible participant. Each source replacement receives a
new playback ID, so late commands, votes and ended callbacks cannot change the
next video.

Participants can add allowed YouTube or youtu.be URLs and Shorts. The server
normalizes them to a video ID, constructs its own fixed oEmbed URL and ignores
returned HTML. Metadata requests have a timeout, size bound and no redirects.
Titles can be entered when metadata fails. The queue holds at most 100 videos;
contributors can remove their own upcoming entries. Private persistent lists
store up to 100 YouTube IDs and titles per list. Skip requires a strict majority
of present viewers, with one vote per account and playback. Votes and advancement
are serialized to prevent two simultaneous requests from skipping twice.

Local consent is required before loading the official player. Player controls
and branding remain visible; its viewport is at least 200 by 200 pixels, including
at 375-pixel phone width. Local volume/mute do not affect microphone, screen,
system-audio or recorded source tracks. Autoplay denial, buffering, deleted or
private videos, embedding restrictions and identification error 153 have visible
recovery states. Ads and provider restrictions can prevent synchronized progress.
This feature does not download/proxy videos or promise live-stream support.

## Isolated player deployment

The same Railway service serves a separate credential-free hostname,
`https://player.bettrcomms.com`. Set `YOUTUBE_PLAYER_ORIGIN` to that exact origin
only after DNS and HTTPS work. Leave it empty to keep YouTube disabled. It must
be distinct from `APP_URL`; HTTP is allowed only for loopback development.

The player hostname is intercepted before authentication, ordinary security
middleware and the SPA. Only `/player`, `/player.js`, `/claim` and `/healthz` are
served. Authentication, API, WebSocket and other paths return 404. The helper
does not resolve session cookies or set cookies. Its routes expose no native
operations, and its media permission policy denies camera/microphone access.
The official external SDK is loaded only inside this helper, never in the app
document. These HTTP restrictions do not by themselves prove that a native
WebView isolates its runtime from child frames.

The production hostname is reserved even before YouTube is enabled. With an
empty or different helper origin it serves only `/healthz` with a disabled
status; every app, authentication, API, WebSocket and player route returns 404.
Adding DNS therefore does not expose the main application while TLS and feature
configuration are still pending.

A fresh nonce and MessageChannel bind each instance to the exact iframe window
and helper origin. Commands/events have a fixed allowlist and numeric bounds.
An authenticated, scoped bootstrap ticket is hashed in PostgreSQL, expires
after 60 seconds and can be claimed once; claim rechecks session, membership and
playback. It authorizes only a public video ID. Session, API and native page
tokens are not forwarded by the player bridge. The protocol retains an opaque
native-parent ticket path: `/player?opaque=1` omits frame-ancestors because CSP
cannot name an opaque origin. This protocol does not override the macOS app's
frame prohibition. Other helper responses restrict framing to the app and known
Wails origins. Closing, source replacement, account change and access loss
destroy frames, players, ports, listeners and timers.

Add Railway's returned CNAME and verification TXT records in Cloudflare, using
the exact values for the new custom domain. Keep existing app and Railway alias
domains. Use DNS-only initially and verify TLS and the credential-route denials
before enabling the feature. Railway serves the backend; no second application
server or YouTube API key is needed.

## Native frame boundary

The repository remains on Wails v3.0.0-beta.18. Source auditing of that version
and beta.28 found that macOS child frames can reach the raw
`window.webkit.messageHandlers.external` handler; its dispatch path has no
pre-dispatch main-frame/origin check. The audited path includes
`webview_window_darwin.m` and the application message dispatcher. A
credential-free HTTPS helper, nonce, consent,
PageToken checks on application services and HTTP middleware cannot establish
isolation for that raw WebKit transport. This is a runtime source finding, not
a completed packaged exploit or playback acceptance run. The pinned beta.18
GTK3/GTK4 Linux handlers have the same missing frame admission: they use the
top WebView URI when forwarding messages, rather than identifying the sender.

Non-Windows native hosts therefore emit `frame-src 'none'` in development and
packaged documents, selected from the host's `runtime.GOOS`. The frontend also
recognizes the validated Wails platform before creating a player scope: it offers
no YouTube iframe or consent control, disables YouTube viewing participation,
and explains the browser requirement. File video playback and private lists are
preserved. Only Windows retains the single fixed helper frame origin. That
policy still requires packaged native runtime isolation acceptance.

The native HTTP dispatcher separately requires a per-launch PageGate proof in
`X-BetterComms-Page-Proof` on the exact `/wails/runtime` path. The boot script
signs only the main document's own protocol/host/origin and exact runtime path,
with redirects rejected. Missing/null origins still require that proof;
external origins, cross-site requests, document/image requests, escaped aliases,
descendants and invalid proofs are rejected before HTTP dispatch. The proof is
removed before forwarding to the runtime. This protects the HTTP transport;
it does not intercept raw WebKit messages or justify lifting the non-Windows gate.

No Wails upgrade or runtime fork is included. Re-enabling YouTube in macOS/Linux
desktop requires a verified native frame-isolation boundary and subsequent real
packaged acceptance. Until then, those platforms use the browser and the requested
Windows/macOS native YouTube delivery remains incomplete.

## Acceptance boundary

Unit/integration tests cover URL parsing, metadata bounds, ownership, capability
compatibility, queue capacity, concurrent votes/advancement, viewer leases,
one-use tickets, helper isolation and player lifecycle. Deterministic native CSP
tests cover Darwin/Windows/Linux in development and packaged modes; frontend
tests cover the non-Windows gate, preserved file/list UI and the Windows/browser
consent flow. Focused HTTP proof tests exercise the installed SDK's window,
binding, chunked calls and legacy GET shape. Those Node/handler tests do not
establish provider playback or packaged native isolation.

Acceptance still requires the real official player over HTTPS with two viewers.
Windows requires a real packaged Wails run for playback, controls, transfer,
CSP, identification and rejection of credentials/native functions. The current
macOS package must verify the intentional gate, no helper request/frame, and
continued file/list use; YouTube playback acceptance there remains blocked until
frame isolation is fixed. Compilation, mocked players and a passing gate test
do not satisfy those outstanding native playback requirements.
