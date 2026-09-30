# Media ownership in browser and packaged apps

The shared React frontend owns call controls, layout, participant state, and
user-visible errors. The Go service owns room membership and signaling. A
packaged app's native host should own operating-system capture, audio routing,
encoding, and the lifetime of media that must continue while its webview is
hidden. The browser build uses browser media APIs for the same user actions.
Changing the UI or navigating to Messages must not release an active call.

| Source or operation | Browser | Packaged app target | Current status |
| --- | --- | --- | --- |
| Microphone and camera | `getUserMedia` | Native device capture and audio session, with independently switchable tracks | iPhone audio session is native, but microphone and phone camera tracks still originate in WebKit. |
| Incoming call audio | Browser media playback | Native audio session and a persistent playback owner | iPhone uses media elements under a native audio session; call playback stays mounted across in-app navigation. Background audibility has been tested on one iPhone. |
| Screen and optional system audio | `getDisplayMedia` where supported | Native capture and encoding, independent of webview visibility | Windows has a native capture/transport path. macOS uses webview capture. The experimental iPhone broadcast extension captures the whole screen, encodes H.264 and owns its native WebRTC sender. A signed iPhone app-switch test confirmed remote sharing and the OS indicator; screen system audio is not yet included. |
| Meta glasses camera | Unavailable unless the browser exposes a standard camera | Meta DAT session and media transport on iPhone | DAT captures natively; VideoToolbox H.264 and the native WebRTC hub send call video to capable clients. JPEG/canvas provides local preview and the ordinary call fallback. Gen 2 streaming has been exercised, but repeatability and remote native-stream quality remain acceptance work. |
| Call signaling | Authorized WebSocket and WebRTC negotiation | Same authenticated room signaling; native sender must use scoped credentials and release them on leave | Ordinary media peer connections still live in the webview on iPhone. |

The iPhone glasses call path now encodes and sends outside WKWebView. Each
participant starts with the ordinary canvas camera and upgrades only after
answering the native capability query and completing a separate native-camera
connection. Failed connections, missing or stalled decoded frames, and
sustained loss restore that participant's ordinary camera. Receiver failures
release their native connection and watchdogs. Fallback requests survive
temporary signaling outages through a notification retry bounded
to 20 seconds; call disposal, peer removal, or capture replacement cancels it.
Local preview and fallback still use bounded JPEG delivery and
`canvas.captureStream()`. These compatibility paths cannot promise media after
iOS suspends WKWebView. The experimental broadcast extension uses a separate
native sender instead.

Glasses capture and sending stay native during an active call. A physical iPhone
app-switch test passed after decoder recovery was added; locked-phone video and
long-duration background delivery remain unverified. Room signaling, capability negotiation,
and fallback decisions still run in the webview. Adding a background mode alone
does not establish continued delivery or recovery during suspension.

The local background-recovery build retries invalid VideoToolbox sessions and
temporarily unavailable decoders/encoders from the native frame callback, with
backoff capped at five seconds. A recreated decoder waits for a source keyframe;
the encoder requests a fresh output keyframe. Terminal codec errors still stop
capture. A physical iPhone test identified decoder invalidation (`-12903`)
immediately after backgrounding. After recovery was added, native logs showed
continued output while backgrounded, and the user confirmed the glasses video
continued. Bounded native diagnostics in `Library/Caches/NativeMedia`
record frame rates, numeric codec errors and foreground transitions, without
media, signaling payloads or credentials. The two rotating files total roughly
512 KiB. Preview availability does not own an active native sender's lifetime.

The experimental whole-phone share uses a ReplayKit Broadcast Upload Extension.
Its sample buffers go directly to VideoToolbox and a separate native WebRTC hub
inside the extension. No screen pixels pass through the host or its webview.
The host starts a loopback control listener and writes a random, single-use
32-byte connection key into the private broadcast App Group. It expires after
two minutes and is removed on connection or cancellation. Control messages are
bounded; closing the host connection ends capture and releases the extension's
encoder and peers. Existing authenticated room signaling handles negotiation;
new viewers and renegotiation still require the host webview to be running.

The iOS broadcast picker requires an explicit user start and provides the OS
sharing indicator and stop control. The call microphone stays independent;
ReplayKit microphone and system-audio samples are ignored in this first version.
The app and extension need separate development profiles with the same broadcast
App Group. A signed iPhone test confirmed remote screen sharing continues after
leaving BetterComms, with the OS broadcast indicator visible. Extension memory
use, orientation, locked-phone and long-duration operation, denied/cancelled
starts, force-quit and stop behavior still require signed-device acceptance.

The native sender boundary already carries Meta DAT call frames and should
also carry phone camera frames if background video is supported by the OS and SDK. The interface exposed to
React should be commands and state (`start`, `stop`, source, permission,
failure), never per-frame base64 media. Keep each participant's microphone,
camera, screen, and system audio independent, including recording tracks and
volume controls. Preserve the browser pipeline for browser clients and as an
explicit foreground fallback where a native capability is unavailable.

Acceptance requires two physical participants: switch between BetterComms and
other apps while speaking, listening, sharing the whole phone, and using the
camera; the remote peer must receive continuous media and the iPhone must show
the OS broadcast indicator. Repeat with Messages open inside BetterComms,
screen/audio stopped independently, a lost network, denied permissions, and
call teardown. Browser synthetic-media tests are useful regression coverage
but do not establish these native behaviors.
