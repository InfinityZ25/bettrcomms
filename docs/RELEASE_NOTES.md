## Unreleased — combined review follow-up

Native screen and glasses senders now receive renewed TURN configuration,
including peers still gathering candidates. Direct-only peers keep relay
servers excluded, and local previews remain isolated. Updating credentials
preserves capture and tracks; it does not itself restart an ICE connection.
A replaced broadcast also protects its own start deadline from an older
signaling timer callback that was already running. The macOS
media-permission translation unit is excluded from iOS builds.
Custom desktop frames explicitly fill the remaining viewport at phone-sized
breakpoints. CI also checks optimized phone layouts in Chromium and WebKit.

Validation after reconciling current main: frontend build and 362 unit tests, targeted native credential
renewal tests with the race detector, native authorization checks, Go vet,
and a complete ad hoc iOS archive with its broadcast extension. Full browser
and database checks for this follow-up remain pending. These checks do not
establish physical-device or cross-network media acceptance.

# BetterComms preview release notes

## Unreleased — mobile navigation and conversations

Messages and Calls now open full-screen mobile lists with filtering, readable
rows and explicit back navigation. Phone navigation has four destinations:
Home, Messages, Calls and You. Friends is available through + in Messages,
including when the phone is held sideways; the desktop Friends rail remains.
Home opens the home screen, and Recordings is available in the account menu
alongside Settings. Navigation preserves the
active call, whose compact controls sit above the page rather than covering
the message composer.

Direct messages have one mobile header, a growing one-line composer and
explicit message menus. Reading or scrolling no longer expands message rows.
Dates separate message history; drafts survive returning to the conversation
list. The visible viewport bounds the interface while the keyboard is open,
and message scrolling stays inside the thread. Dialogs, menus and controls
respect phone safe areas and minimum touch sizes in portrait and landscape.

The packaged build also preserves full-screen Friends and Settings positioning
after CSS optimization. Dialog centering and full-screen overrides now use the
same transform property; mixing individual translation with transform resets
left sheets half off-screen in the optimized assets. With the local API/database
running, `npm run test:e2e:production-mobile` builds and checks the actual
production assets in Chromium and WebKit, including rotation and keyboard
layout. This is separate from development-server browser tests.

Phone Settings and Friends backgrounds now reach behind the status bar and
home indicator. Safe-area spacing is applied to controls and the end of the
scrolling content rather than leaving a separate band around the page.
Settings uses its category selector as the phone heading, freeing the space
previously occupied by a duplicate category title.

Mobile navigation supports a right swipe from the left edge to go back and a
left swipe from the right edge to go forward. History includes conversations,
lists, Recordings and full-screen Settings/Friends panels; navigation does not
restart or end the call. Vertical scrolling, editable controls, sliders,
video gestures and the transient native screen picker keep their own gestures.
Chromium checks use browser-dispatched touch input with a synthetic-microphone
call. Desktop WebKit checks deliver touch sequences to the page's listeners
from a call lobby; physical iPhone gesture acceptance remains required.

Validation: web build, 285 unit tests, Chromium mobile/live-call and desktop
conversation regressions, WebKit conversation/keyboard layout regression, and
A/AA accessibility checks for the new conversation and list surfaces. Keyboard
geometry is emulated in these tests; physical iPhone keyboard and interaction
acceptance is still required before declaring the interface production-ready.

## Unreleased — signaling delivery

The signaling server no longer drops a message silently when a participant's
queue is full. It disconnects that participant, whose client reconnects and
receives a fresh snapshot of the call, and the queue is larger (256 messages,
from 32). In the client, an offer that goes unanswered is sent again after
five seconds, so a lost offer or answer no longer leaves two people unable to
exchange a camera, share or route change for the rest of the call; a
connection that stays disconnected for five seconds now looks for a new route
instead of waiting for the browser to declare it failed. Verified with unit
tests and two-engine browser tests that discard the first offer or answer;
not measured on real network changes.
## Unreleased — call video quality rules

Browser and WebView calls now state one codec order on every client (H.264
Constrained Baseline first, then VP8), so a pair of devices no longer lands on
a different codec depending on who connected first. A camera has its own
bitrate ceiling sized to its picture (2.5 Mbps at 720p) instead of the
screen-share ceiling (20 Mbps by default), keeps its capture frame rate, and
each viewer's share of a ceiling shrinks once more than two people are
watching. Applying these settings is serialized and retried, which removes
intermittent errors during joins. Your own preview is no longer mirrored for a
rear camera or the glasses. Call diagnostics now include what limited the
encoder, the encoder or decoder in use, freezes, dropped frames, and the
link's estimated capacity. Verified in Chromium with a synthetic camera over
the real signaling server; hardware encoding on phones and Safari's behaviour
were not measured.
## Unreleased — iPhone video sender timing

Ray-Ban and iPhone screen-broadcast video is now stamped with each frame's own
capture time instead of a fixed 30 fps grid, which drifted and jumped whenever
the source ran slower or unevenly. Screen broadcasts no longer discard frames
that arrive a few milliseconds early, and landscape apps are rotated upright
before encoding (at the already scaled-down size, to respect the extension's
memory limit). Both senders now schedule a keyframe about every four seconds
instead of every second; viewers still get one as they connect and whenever
they request it. The pacer runs with more headroom above the encoder's cap.
The build is installed on a physical iPhone, but playback smoothness,
landscape rotation and extension memory under rotation have not yet been
measured on a real call.
## Unreleased — iPhone layout polish

Phone styles now apply to a phone held sideways too: the `phone` Tailwind
variant had compiled to the portrait width query alone, so landscape phones got
desktop sizing for every `phone:` utility. Notices drop from the top under the
status bar at full width instead of a half-width column that covered the call
controls and tab bar (and blocked taps on them); they were also offset by a
doubled centring transform. The status bar area matches the content rather
than a lighter strip, Settings opens as a full-screen sheet, the connection
indicator shares the call controls' row unless a text status needs its own
line, the chat header shows Mark as read as an icon, and a friend's actions
wrap under their name. Checked in Chromium with the iOS boot report and
emulated iPhone safe areas at 402×874 in both orientations, and installed on
a physical iPhone; safe-area rendering on the device itself was not
separately measured.
## Unreleased — visual copilot reliability

Sharing now opens the participant permission panel, and viewers see whether
indications appear inside BetterComms, over a native Windows source, or are
temporarily hidden/unavailable. Native overlays belong to the active call and
survive navigation to Home, Messages and other screens. Stopping a share,
revoking permission and leaving the call remove its indications.

Laser movement uses a separate unordered channel with no retransmissions,
eight updates per second and a bounded 450 ms fading trail. Points, captures
and permissions keep the reliable channel. Busy connections drop stale
movement rather than accumulating it. Older clients can still use points and
captures; the laser requires support on both ends.

Windows overlays cache artwork and reconcile small position/expiry updates.
They hide while the shared application is not in front and recover after a
temporary source loss. Capture overlays remain excluded from screen capture.
Idle sharing has no overlay polling; active indications renew a bounded host
lease. Corrupt captures are discarded individually. Frozen frames expire
after 60 seconds, and canceling preparation prevents a late send. Manual
captures stay until dismissed/revoked, with at most five retained indications.

Validation includes web build/unit tests, real local API/database browser
flows and Windows overlay/service tests. These do not establish macOS external
overlays or cross-network acceptance. The unchanged Windows real-recording
acceptance test still intermittently fails to receive a decodable IDR within
its four-second recording window on the development machine, including with
an animated source. Native recording acceptance remains open.
See [Visual copilot](VISUAL_COPILOT.md) for behavior and limits.

## Unreleased — push-to-talk cues

Push-to-talk now plays short, local opening and closing tones when the call microphone actually starts and stops transmitting, including with the Windows global shortcut. The cues can be disabled in Push-to-talk settings and follow the app-wide Sounds switch and Sound volume. Joining and leaving a call do not trigger these cues.

## Unreleased — iPhone background media

The experimental iPhone build now includes a ReplayKit Broadcast Upload
Extension for whole-phone screen sharing. Capture, H.264 encoding and sending
run in the extension rather than the webview. Development installation requires
separate host and extension profiles with their shared App Group enabled.
Screen system audio is not included; the call microphone remains independent.

The app and extension authenticate each other with single-use keys, so another
app cannot receive the screen by binding the loopback handoff port. A broadcast
ends when the call page is reloaded, when the page returns and finds it stopped
from the iOS indicator, and when the call's signaling socket (carried by the
host's API proxy) stays closed for 30 seconds while the page is suspended.
Builds without the API proxy (a development build talking to the API directly)
do not have that last safeguard.

Signed-device testing confirmed screen sharing continues after switching to
another app, with the iOS broadcast indicator visible. Ray-Ban video also
continued after app switching following native decoder/encoder recovery fixes.
Locking the phone, long-duration operation, orientation changes, and broadcast
stop/error paths remain acceptance work. Built-in phone cameras still use the
foreground webview capture path.

## 0.1.19 — Call resize fixes (current)

Includes all 0.1.18 mobile and adaptive glasses video changes, plus fixes from
late review of the combined release. Narrowing a Windows call window keeps
its active native camera overlay running; More can show or hide it, and leaving
the call still closes it.
An untouched direct-call chat default follows the current screen size until
the user explicitly opens or closes chat, then preserves their choice.

Validation: web build, 280 unit tests and browser regressions with the real
local API/database; native overlay calls are mocked in the resize regression,
so it does not establish physical Windows overlay acceptance. Platform and
native media limits remain unchanged. See [downloads](releases/0.1.19.md).

## 0.1.18 — Wails application release

This release includes the phone layout and adaptive native glasses video fixes.
Windows x64, macOS Apple Silicon/Intel DMGs, and an experimental re-signable
iOS IPA are available together. See the [download and compatibility
notes](releases/0.1.18.md). Native acceptance limits still apply.

### Adaptive glasses video and recovery

The native iPhone glasses sender retains its 720×1280 at 30 fps capture target.
H.264 starts at 3 Mbps, grows conservatively toward 8 Mbps after sustained
low-loss receiver reports, and backs off on loss or a receiver bitrate limit.
This is loss/REMB-driven adaptation, not a transport-wide bandwidth estimator.
Stale or missing reports prevent increases. Each mesh viewer gets its own
connection; the most constrained viewer limits the shared encoder rate.
Encoder output has a one-second cap at 1.25 times its target, and RTP pacing
follows rate changes without refilling its burst bucket.

Viewer PLI/FIR requests and queue overflow now request a fresh encoder frame
without restarting the glasses session. Recovery requests are coalesced to
at most one per half second. Each viewer's queue stays bounded; overflow
requests recovery without treating deliberate keyframe pacing as stale video.
A queue delayed over 250 ms for two seconds requests an IDR, keeps sending its
existing reference chain, then replaces the backlog when the fresh IDR arrives.
Rejected encoder bitrate updates retain the running camera session and retry
after a cooldown instead of stopping capture.
These controls run from native camera frames, independently of web timers.
Diagnostics include the encoder's current target bitrate.

Five supplied outdoor receiver recordings measured 720×1280, 22–26 average
fps, and 2.6–3.1 Mbps, with timestamp gaps as long as 4.9 seconds. These file
measurements do not isolate capture, network, receiver, or recording failures.
The new path still needs a signed iPhone and remote receiver check, including
variable uplink conditions and multiple viewers, before promising stable 30 fps.

### Phone layout review fixes

Phone calls keep six 44 px primary controls in one row, with camera source
selection in More and connection/push-to-talk/reconnect status in a separate
row. Direct-call chat starts closed on a phone and has a Back to call button.
Touching a message explicitly focuses it to reveal its actions; keyboard users
can also focus the message. More includes clear screen focus, camera-dock
positions and Reset layout without stopping watched media. Fullscreen is only
offered when the browser positively exposes it, and calls guard missing APIs.
These changes still require a packaged iPhone check; synthetic browser media
and layout tests do not establish device behavior.

### Phone layout

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

## 0.1.17 — Wails application release

Windows x64, macOS Apple Silicon/Intel DMGs, and an experimental re-signable
iOS IPA are published together as the latest release. See the [download and
compatibility notes](releases/0.1.17.md). Native acceptance limits still apply.

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

The macOS Share button now opens the webview's working screen picker directly. macOS has no native window-capture adapter, so the native source list and its FFmpeg setup no longer appear there. For packaged macOS builds, the bundled app page receives its WebKit camera/microphone grant without a second site prompt; macOS still asks for app-level access when each device is first used. Physical-device acceptance remains pending.

Mobile browser calls now offer an in-call camera picker for sources the browser exposes. Choosing a source while video is off saves it for the next camera-on action; switching while video is on replaces only the camera without recapturing the microphone. If the selected camera cannot be opened, the current video stays live and the app reports that the device may be busy or unavailable. For browsers that cannot open two cameras at once, it suggests turning video off before switching. Direct Meta Ray-Ban camera streaming is not implemented in the browser client; it needs a native mobile integration and device acceptance testing.

On narrow screens, the conversations toggle opens a right-side drawer over the current view. The drawer takes two-thirds of the viewport, and selecting a room closes it. The Friends dialog stays within the visible phone viewport and scrolls its contents when the list is long.

When a mobile browser does not expose `getDisplayMedia` (including the reported iPhone Safari and Chrome cases), Share now explains that screen presentation requires the desktop app or a supporting desktop browser. The error notice wraps within the phone viewport instead of overflowing sideways. The website cannot grant a screen-capture API that the iPhone browser does not provide.

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
## Unreleased — experimental Android host

Android now has a separately buildable Wails native package with shared UI,
encrypted session persistence, native permission/audio-focus handling and
system back navigation. A standard APK supports API 26+ without Meta's SDK;
the Meta APK requires API 31+ and includes DAT 1.0.0 camera bindings and the
native H.264/WebRTC sender. Screen sharing uses Android MediaProjection and
native encoding rather than browser getDisplayMedia. CI builds both flavors.

Phone camera/microphone transport still uses WebView WebRTC; system audio
capture and production Android notification delivery are not implemented.
Hardware, background-media and cross-network acceptance remain pending.
See [Android setup and the device acceptance checklist](ANDROID.md).
