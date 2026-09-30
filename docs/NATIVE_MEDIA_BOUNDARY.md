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
| Screen and optional system audio | `getDisplayMedia` where supported | Native capture and encoding, independent of webview visibility | Windows has a native capture/transport path. macOS uses webview capture. iPhone ReplayKit captures only the foreground BetterComms screen, then sends JPEG frames through the webview; it stops on background. |
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
`canvas.captureStream()`, and the ReplayKit
in-app screen source also publishes through a canvas. These webview paths
cannot promise media after iOS suspends WKWebView.

Glasses capture and sending stay native during an active call, but background
and locked-phone video remain unverified. Room signaling, capability negotiation,
and fallback decisions still run in the webview. Adding a background mode alone
does not establish continued delivery or recovery during suspension.

The local background-recovery build retries invalid VideoToolbox sessions and
temporarily unavailable decoders/encoders from the native frame callback, with
backoff capped at five seconds. A recreated decoder waits for a source keyframe;
the encoder requests a fresh output keyframe. Terminal codec errors still stop
capture. A physical iPhone test identified decoder invalidation (`-12903`)
immediately after backgrounding; continued delivery with recovery is still an
acceptance gate. Bounded native diagnostics in `Library/Caches/NativeMedia`
record frame rates, numeric codec errors and foreground transitions, without
media, signaling payloads or credentials. The two rotating files total roughly
512 KiB. Preview availability does not own an active native sender's lifetime.

The next iPhone screen-sharing implementation needs a ReplayKit Broadcast
Upload Extension for other apps and the system broadcast indicator. Its sample
buffers must reach a native video encoder and a native network sender with
bounded queues. The host and extension need an explicit authenticated session
handoff and an App Group IPC contract; the extension cannot inherit a webview
session token or write one to logs. Native signaling and peer transport must
survive webview suspension. On stop, error, call leave, or extension exit, the
app must stop the broadcast and release buffers, encoders, sockets, tracks,
and any system-audio capture together. The in-app ReplayKit source should stay
labeled as BetterComms-only until this path is accepted on a physical phone.

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
