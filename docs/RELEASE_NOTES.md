# BetterComms preview release notes

## Unreleased — phone layout

Phone-sized windows no longer render the desktop layout squeezed. Portrait
phones navigate from a bottom tab bar, and Messages and Calls open the
conversation drawer; content meets the screen edges instead of an inset card.
A phone held sideways uses the drawer too. In a call, cameras share the
available height (side by side in landscape) above a single row of 44 px
controls, and recording, layout, chat, invite, focus and fullscreen are in a
More menu. Room chat fills the screen with its own back button and sits above
the call controls. On touch screens a message's actions appear when it is
tapped. Checked with synthetic media in Chromium at iPhone 15 and iPhone SE
sizes, portrait and landscape; the packaged iPhone app has not been
re-accepted on a device.

## Unreleased — experimental iPhone host

The iPhone Meta glasses camera request now stays pending while Meta AI opens
for registration or camera permission. Returning from Meta AI resumes capture
automatically, and the app no longer reports an immediate error or stops the
pending request merely because the handoff backgrounds BetterComms. Meta AI
can briefly return before its glasses link reconnects, so the host now waits
up to a minute for an eligible device before checking camera permission. The
next device build keeps Meta's selector alive during the request, retries
transient session startup failures, and logs error codes without device IDs.
After a Meta AI camera grant, the native bridge waits until BetterComms is
active again before starting the glasses session. A physical retry confirmed
that it waited, but the camera link still failed: CoreBluetooth logged an
L2CAP channel closure, followed by session-start errors. A further build lets
the accessory handoff settle briefly after activation and reports clearly
that Bluetooth headset audio and the DAT camera link are separate. Repeatable
glasses capture is still unverified. The glasses report release 129 and DAT
component 1.0.0.0.0; the app embeds DAT SDK 1.0.0.
An earlier device experiment kept the native glasses session alive when
BetterComms backgrounded. The current bridge publishes through WKWebView, so
it now stops an active DAT session on background and reports the ended camera
track when the app resumes. This avoids leaving the glasses with an active
session after the webview stops publishing. Background video still needs a
native sender outside WKWebView.
The iPhone call now publishes its captured microphone directly instead of
routing it through a Web Audio output track, which could be silent even while
iOS showed the microphone privacy indicator. It also configures the native
voice-call audio session before opening the WebKit microphone. A two-person
call confirmed that the other participant can hear the iPhone after it leaves
BetterComms. Incoming audio stopped in the background with the Web Audio
playback graph, so iPhone remote tracks now play through media elements under
the native audio session. A signed-device check confirmed incoming audio
continues; microphone effects and voice balancing are bypassed on this iPhone path.
Remote voice and watched screen-audio playback now belong to the persistent
call session, so opening Messages or another screen does not remove them while
the call continues. A two-person browser regression test covers this
navigation path.
The browser/native ownership and physical acceptance requirements for continued
screen and video sharing are recorded in [native media boundary](NATIVE_MEDIA_BOUNDARY.md).
Meta AI can still report its own registration error; streaming from Gen 1 and Gen 2
glasses awaits a successful physical-device acceptance test.

The next iPhone preview stores its proxy session in Apple Keychain so closing
the app no longer discards sign-in. The iPhone native call, screen, and glasses
bridges now use stable Wails binding IDs. Camera startup retries with lower
constraints if WebKit rejects the requested mode, while permission denials
still surface normally. Mobile dialogs and the conversations drawer reserve
the status-bar safe area, and the packaged WKWebView disables whole-page pinch
zoom. These changes await a fresh signed-device acceptance check.

The experimental iPhone host now keeps videos inline in the call, fills the
mobile viewport without the 600 px minimum-height overflow, and suppresses
WebKit's extra media prompt for its own packaged page while retaining iOS's
native permission prompt. This is a build-level change awaiting a fresh signed
device check. Background calls, Meta glasses capture, and iPhone screen
sharing remain native-media work, not browser capabilities. The iPhone build
now has a ReplayKit in-app screen track for the foreground BetterComms screen;
full-phone sharing and device acceptance are still outstanding.

An experimental iOS-only Ray-Ban Meta source is being wired into the call
camera picker and camera settings preview through Meta's native Device Access
Toolkit. It currently needs Developer Mode and physical Gen 1/Gen 2 device
acceptance; browser builds do
not expose glasses as a normal `videoinput` device.
The iOS host now sets a native call audio session only for active calls and
declares audio background mode. It still needs a signed-device background call
test before promising uninterrupted audio outside the app.

## Unreleased — message privacy, previews and background alerts

Direct conversations now require friendship or an accepted message request;
receiving requests is opt-in. Blocking revokes the direct conversation and
prevents further contact. Messages link HTTP(S) URLs and show lazy image,
on-demand audio/video previews while preserving file downloads. Optional
browser Web Push can notify after a tab closes when the server has VAPID keys;
optional Wails close-to-tray keeps native Windows and macOS notifications
available while the process remains running. Desktop alerts now have their own
device-local opt-in, and clicking one opens its conversation. Web Push delivery
was verified in local Chrome with the recipient tab closed; packaged desktop
behavior and other browsers still need acceptance. Attachment malware
scanning is not part of this change.

## Unreleased — messaging controls and attachments

Message sends now carry an idempotency key, and an active conversation fills message gaps through paginated HTTP after reconnect. Room and direct-message lists follow recent message activity. The composer keeps a per-conversation draft on this device across browser restarts, shows typing and the first unread message, and supports up to four 10 MB attachments per message when private S3 storage is configured. Room owners can review, dismiss, and act on message reports; message sends, reactions, reports, uploads, and moderation have rate limits. Per-conversation notification modes are stored with the account, while Do Not Disturb and system notification opt-in are local to the device. See [messaging controls and limits](MESSAGING.md).


## Unreleased — Wails-only desktop build

The desktop app now builds solely from `apps/desktop-wails`. The removed desktop host, its JavaScript dependency, packaging workflow, and obsolete native test fixtures are no longer part of the repository. The shared frontend selects browser or Wails adapters from the validated desktop boot report. Windows builds stage the pinned FFmpeg runtime and model assets for Wails. macOS places native traffic lights over the app's own title area, bundles the BetterComms icon, ad hoc signs and verifies the Wails app, then provides one drag-to-Applications DMG per architecture. GitHub Actions wraps each DMG in an artifact ZIP. These builds remain unsigned by Developer ID and unnotarized; users may need Privacy & Security → Open Anyway.

The Wails native media implementations still require physical-device and packaged authentication acceptance. macOS uses webview capture where supported and does not claim Windows native capture, process audio, or GPU processing. See [desktop validation status](WAILS_COMPLETION.md).

Mobile browser calls now offer an in-call camera picker for sources the browser exposes. Choosing a source while video is off saves it for the next camera-on action; switching while video is on replaces only the camera without recapturing the microphone. If the selected camera cannot be opened, the current video stays live and the app reports that the device may be busy or unavailable. For browsers that cannot open two cameras at once, it suggests turning video off before switching. Direct Meta Ray-Ban camera streaming is not implemented in the browser client; it needs a native mobile integration and device acceptance testing.

On narrow screens, the conversations toggle opens a right-side drawer over the current view. The drawer takes two-thirds of the viewport, and selecting a room closes it. The Friends dialog stays within the visible phone viewport and scrolls its contents when the list is long.

## Unreleased — messaging basics

Direct and room conversations support persistent unread and mention badges, mark-as-read, paginated history, authorized full-text search with conversation and author filters, own-message edit and delete, replies, and emoji reactions. Changes synchronize through the event stream, and reconnect reconciles history. Migration 003 preserves existing content. See [messaging controls and limits](MESSAGING.md).

## Current browser and service limits

Browser microphone, camera, and screen sharing use WebRTC, with synthetic-media browser tests against the real API/database. These tests do not prove native capture, physical devices, or external-network connectivity. The Go service has an encrypted microphone-only WebSocket fallback; camera, screen, and shared audio still need direct WebRTC or TURN. A production TURN deployment and cross-network validation remain outstanding. Packaged WorkOS sign-in and real account acceptance remain separate gates.

## Unreleased — experimental iPhone glasses quality and teardown

Ray-Ban Meta capture now requests 720×1280 at 30 fps instead of 360×640 at
15 fps, raises bridge JPEG quality, and removes a duplicate timestamp-based
frame limiter. The bridge still uses bounded, single-frame webview delivery;
30 fps is a capture target, not a verified end-to-end result. A supplied remote
recording from the previous build measured 360×640 and 8.9 fps over 267 seconds.

Native teardown now lets the parent device session stop its camera/stream and
retains those objects until the terminal stopped state. Repeated startup
rejections are bounded. Glasses can still require a physical reset; repeated
stop/restart, app-switch, and locked-phone acceptance remain outstanding.

The iPhone app can now send glasses video from a native H.264 sender instead of
the webview canvas, targeting 720×1280 at 30 fps. Phone logs measured the
encoder producing about 30 fps at 720×1280; remote receipt of the native stream
at that rate has not yet been measured on a real call. Each participant first
receives the ordinary call camera. The phone switches a participant to the
native stream only after that client answers a capability query and the native
connection completes within 15 seconds, and switches back if the connection is
lost for about six seconds. Clients built before the native receiver — for
example desktop apps packaged before this change — therefore keep the
lower-quality ordinary camera instead of showing no video. Receivers no longer
report a native camera interruption while video is arriving. Background and
locked-phone glasses video are still unverified.

Native camera receivers now also request fallback when no video can be decoded,
decoded frames stop advancing, or sustained loss prevents usable playback while
the connection remains connected. The sender restores that viewer's ordinary
camera, and the failed receiver releases its connection and watchdog timers.
Fallback notifications retry for up to 20 seconds if signaling is reconnecting;
leaving the call, removing the peer, or replacing its capture cancels the retry.
Disposing the camera transport removes its signaling error listener. The iOS
package no longer declares the unused background-processing mode, and session
persistence guidance now describes the operating-system credential store
without incorrectly naming a Windows account on Apple platforms.
