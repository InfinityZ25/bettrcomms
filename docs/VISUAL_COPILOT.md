# Visual copilot

Enable **Shared-screen reactions** in Voice & devices on both devices. Each
new share opens its permission panel. The sharer chooses who may send signals
and who may send marked captures; grants are independent per participant and
expire when the source changes or sharing stops. Pause all indications revokes
the grants and removes received marks. Device settings remain opt-in.
New participants are never allowed automatically. Turning off the feature or
a reception mode revokes the corresponding incoming permissions.

The viewer can point once, hold and drag the laser, or freeze a single frame
locally and mark it. Freezing never pauses the outgoing share. Captures must be
sent within 60 seconds; returning to live, losing permission or leaving the
call cancels preparation and releases the canvas. Images are bounded JPEGs,
640 pixels per dimension and 40,000 data-URL characters. They are ephemeral
call data, never implicitly uploaded or persisted.
Back to live or Escape cancels. Enter on the marking surface selects the center.
Optional keyboard shortcuts apply only while the collaboration controls are
focused; typing and enabled push-to-talk take priority. There are no global
copilot shortcuts, object tracking, remote application control or continuous
rewind in this feature.

Signals disappear after the configured duration. Laser trails retain at most
six samples for 450 ms. Disabling Motion or using reduced motion hides the
in-app trail. Close captures can be timed or manual. Manual captures remain
until dismissal, revocation, share end or call end; the five-indication cap can
also evict the oldest mark. Native presentation shows at most four pointers
and the latest capture; the in-app capture list retains the remaining cards.

## Presentation

Browsers and unsupported native platforms show indications inside BetterComms.
Windows native window/display sharing can also display click-through overlays
over the source. They are excluded from capture to avoid sending them back in
the video. Window overlays hide whenever the shared app lacks foreground focus,
even if its window is still visible beside another application. A minimized
source is retried while marks remain active. Resizing the source can require
restarting native sharing; overlays never map onto a different geometry.
Normalized coordinates include the viewer's fit/fill/zoom/pan transforms and
map onto physical DWM window bounds, excluding invisible resize borders.
See [Microsoft's window bounds documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect).
Camera overlay state and independent media tracks are unaffected.

The native renderer belongs to the call provider, so navigation does not stop
it. Viewers receive structured presentation state independently of delivery
acknowledgments: receiving a point does not assert it appeared over an external
window. Older clients without presentation metadata show an unknown state.

## Resource and transport bounds

Reliable negotiated channel 13 carries permissions, points, captures and point
acknowledgments. Latest permission/presentation updates occupy one slot per
peer during backpressure and flush when the buffer drains. Laser channel 14 is
unordered with zero retransmits, negotiated only between compatible clients.
It is paced at eight sends per second, drops buffered movement, rejects stale
token-scoped sequences and does not create acknowledgment timers.
DTLS protects this data path, and peer identity still trusts the authenticated
call signaling. The microphone-only voice relay does not carry collaboration;
voice may continue while the WebRTC collaboration path is unavailable.
Each indication validates permission token, source generation, normalized
coordinates, lifetime, duplicates and image dimensions. Reliable messages are
bounded to 48,000 characters, four outgoing acknowledgments can be pending,
and discrete signals/captures have separate two-per-second receiver limits.
A capture's held time is local freeze duration, not capture-to-viewer latency.

Windows artwork is uploaded only when created, changed or missing from the host
cache. Small Sync batches reconcile positions, visibility, revisions and expiry;
revisions increase independently of signal duration. Native trails use cached
sprites and stop repainting after fading. Active marks renew a four-second
renderer lease every 750 ms. A crashed/stopped renderer cannot leave orphaned
windows indefinitely. No indications means no JavaScript heartbeat and no
native watcher. Cleanup releases channels, listeners, timers, canvases, cached
pixels and native windows on stop/error/disconnect paths.

Push-to-talk shortcuts take precedence over collaboration shortcuts, including
an assigned left mouse button. Unreadable capture artwork is discarded without
disabling other indications. A broken host API falls back to in-app presentation
and stops retrying until a new share; temporary source unavailability is
recoverable while marks remain.

## Validation limits

Unit tests cover transport pacing/backpressure, stale permissions, expiry,
manual retention, renderer caching, asynchronous cancellation and native input
validation. Browser tests use the real local API/PostgreSQL with synthetic media;
navigation tests mock the native bridge. Windows tests create actual overlay
windows and inspect capture exclusion/cleanup. These do not prove macOS
external overlays, protected/fullscreen sources or cross-network connectivity.
The existing real native recording acceptance gate remains unresolved on this
development machine; see release notes for the observed failure.
