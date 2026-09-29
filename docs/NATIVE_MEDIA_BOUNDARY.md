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
| Meta glasses camera | Unavailable unless the browser exposes a standard camera | Meta DAT session and media transport on iPhone | DAT camera capture is native, but frames cross JavaScript/canvas before WebRTC publishing. Repeatable physical-device streaming is not yet established. |
| Call signaling | Authorized WebSocket and WebRTC negotiation | Same authenticated room signaling; native sender must use scoped credentials and release them on leave | Ordinary media peer connections still live in the webview on iPhone. |

The current iPhone bridges turn native frames into `canvas.captureStream()`
tracks. That is useful for an in-app preview, but it cannot promise video or
screen sharing after iOS suspends WKWebView. Adding a background mode alone
does not move capture, encoding, or sending out of the webview.

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

The same native sender boundary should carry phone camera and Meta DAT frames
if background video is supported by the OS and SDK. The interface exposed to
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
