# Visual copilot preview

Visual copilot lets a viewer point at a shared video or freeze their own view and send a marked frame back to the sharer. It is off by default. It does not control the shared application, stop its transmission, follow moving objects, or add a continuous rewind buffer.

## Use

1. Both participants enable **Settings → Visual copilot → Enable visual copilot on this device**.
2. The sharer starts a screen share and expands **Visual copilot** above the call. Allow **signals**, **captures**, or both for each listed participant. New participants are never authorized automatically.
3. The viewer chooses **Watch** on the incoming share. **Point** enables deliberate clicks on the video and displays a temporary local marker as feedback. **Laser** lets the viewer hold the primary pointer button and drag inside the video; release to let the last point expire using Signal duration. Both use Allow signals permission. **Freeze & mark** holds only the viewer's displayed image; select a point and press **Send marked capture**. **Back to live** or Escape cancels. Enter on the marking surface selects the center for keyboard users.
4. The sharer sees the signal on their preview and marked captures as corner cards. **Pause all indications** revokes all current permissions and clears received indications.

Settings remember reception switches, signal size/duration/animation, card size/corner/lifetime and optional keyboard shortcuts on this device. Shortcuts are scoped to the focused collaboration controls. Typing and enabled push-to-talk take priority; assigning a currently used PTT key is rejected. There are no global copilot shortcuts or notification sounds in this preview.

Permissions are tied to the current device endpoint and screen-track generation. Stop, replacement, track end and call disposal invalidate them. Turning off the feature or a reception mode revokes the corresponding permissions. Preferences are saved; permissions and received images are not.

## Native presentation

On the current Windows host, native sharing can additionally present indicators above the captured application. The native source is resolved from the active opaque capture session. Browser capture remains supported for in-app indications, but is not mapped to a Windows application window.

Quick signals are click-through and do not activate their window. For application capture they hide when another window owns foreground. A monitor share is tied to the whole selected display. Native cards show the original marked frame in the selected corner of the source area; the most recent card is shown outside BetterComms and the bounded retained cards remain in the app.

Source coordinates account for both viewer fit/fill/zoom/pan and the native encoder's even-sized letterboxing. Window movement is checked every 100 ms. Resizing the source invalidates native placement until sharing is restarted. This deliberately avoids placing old coordinates over a changed capture area.

Native surfaces require capture exclusion. Frame leases are renewed by the renderer; abandoned surfaces close after 1.2 seconds without renewal, and the watchdog also checks whether the capture still exists. A separate overlay state preserves the camera overlay and media tracks. Up to four native signals and one native card can be displayed.

Microsoft documents that visible DWM frame bounds exclude invisible resize borders and are not DPI-adjusted, unlike GetWindowRect: [GetWindowRect documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect). The implementation uses physical DWM bounds for native application placement.

## Transport and bounds

The existing authenticated call connection gains a reliable, negotiated WebRTC data channel (`bettercomms.visual-copilot.v1`, ID 13). A versioned hello is required before offering collaboration. DTLS protects data between endpoints; authentication of the peer still relies on the existing authenticated signaling path. Images are never sent as server chat messages or persisted to PostgreSQL. The microphone-only voice relay does not carry copilot data; if the WebRTC data path is unavailable, collaboration is unavailable while voice can continue.

Every indication carries a single-use ID, current permission token, share generation and normalized position. The receiver independently validates mode, permission, coordinates, source lifetime, duplicates, image dimensions and limits. An acknowledgement means the sharer client received the indication, not that the person saw it or that a native overlay was visible.

- At most five received indications are retained in memory; old entries are evicted.
- Signals last 1, 2 or 4 seconds. Cards close after 5, 15 or 30 seconds; manual closing still has a one-minute retention ceiling.
- Frozen frames must be sent within one minute. The card's held time is local freeze duration, **not** measured capture-to-viewer latency.
- Captures are bounded JPEGs (40,000 data-URL characters, encoded by the viewer at up to 640×360). Receiver SOF validation rejects dimensions over 640×640 before browser decoding.
- Protocol messages are bounded to 48,000 characters, at most four outgoing acknowledgements are pending, and sends fail under backpressure.
- Discrete indications are limited to two per second per device. Laser movement is sent at most eight times per second while dragging, carries coordinates only, replaces the same retained point per participant and is dropped before sending when the data channel is buffered. The receiver enforces a 100 ms minimum laser interval and the existing five-mark memory ceiling. Sustained protocol flooding closes only that collaboration channel.

## Validation

```powershell
npm run build
npm test
npx playwright test tests/visual-copilot.spec.ts tests/push-to-talk.spec.ts tests/native-screen-audio-lifecycle.spec.ts
```

Browser acceptance uses the real local API/database, two isolated users and synthetic media. It checks opt-in settings, persistence, shortcut conflicts, real data-channel delivery, retained original-frame color after the live source changes, acknowledgements, expiry, revocation, capture restart and unchanged screen-track identity.

`scripts/test-native-visual-copilot.mjs` is an opt-in Windows test for an isolated current debug host on loopback CDP, with `BETTERCOMMS_NATIVE_PROCESS_ID` set to that host's PID. It captures only its own Chrome fixture. `scripts/inspect-copilot-fixture.ps1` verifies geometry, styles, capture affinity, foreground ownership and cleanup. Focus setup may raise and click only the verified synthetic fixture titlebar; do not run the test while using another application. The debug endpoint is for the test only and must not be enabled for ordinary use.

Native acceptance does not prove support for exclusive fullscreen, protected applications, every DPI/display arrangement or macOS. Object tracking, exact capture timestamps, area/freehand annotations and cross-network load acceptance remain outside this preview.
