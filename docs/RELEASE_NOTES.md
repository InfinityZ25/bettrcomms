# BetterComms preview release notes

## Unreleased — Wails-only desktop build

The desktop app now builds solely from `apps/desktop-wails`. The removed desktop host, its JavaScript dependency, packaging workflow, and obsolete native test fixtures are no longer part of the repository. The shared frontend selects browser or Wails adapters from the validated desktop boot report. Windows builds stage the pinned FFmpeg runtime and model assets for Wails. macOS places native traffic lights over the app's own title area, bundles the BetterComms icon, ad hoc signs and verifies the Wails app, then provides one drag-to-Applications DMG per architecture. GitHub Actions wraps each DMG in an artifact ZIP. These builds remain unsigned by Developer ID and unnotarized; users may need Privacy & Security → Open Anyway.

The Wails native media implementations still require physical-device and packaged authentication acceptance. macOS uses webview capture where supported and does not claim Windows native capture, process audio, or GPU processing. See [desktop validation status](WAILS_COMPLETION.md).

The macOS Share button now opens the webview's working screen picker directly. macOS has no native window-capture adapter, so the native source list and its FFmpeg setup no longer appear there. For packaged macOS builds, the bundled app page receives its WebKit camera/microphone grant without a second site prompt; macOS still asks for app-level access when each device is first used. Physical-device acceptance remains pending.

Mobile browser calls now offer an in-call camera picker for sources the browser exposes. Choosing a source while video is off saves it for the next camera-on action; switching while video is on replaces only the camera without recapturing the microphone. If the selected camera cannot be opened, the current video stays live and the app reports that the device may be busy or unavailable. For browsers that cannot open two cameras at once, it suggests turning video off before switching. Direct Meta Ray-Ban camera streaming is not implemented in the browser client; it needs a native mobile integration and device acceptance testing.

On narrow screens, the conversations toggle opens a right-side drawer over the current view. The drawer takes two-thirds of the viewport, and selecting a room closes it. The Friends dialog stays within the visible phone viewport and scrolls its contents when the list is long.

## Unreleased — messaging basics

Direct and room conversations support persistent unread and mention badges, mark-as-read, paginated history, authorized full-text search with conversation and author filters, own-message edit and delete, replies, and emoji reactions. Changes synchronize through the event stream, and reconnect reconciles history. Migration 003 preserves existing content. See [messaging controls and limits](MESSAGING.md).

## Current browser and service limits

Browser microphone, camera, and screen sharing use WebRTC, with synthetic-media browser tests against the real API/database. These tests do not prove native capture, physical devices, or external-network connectivity. The Go service has an encrypted microphone-only WebSocket fallback; camera, screen, and shared audio still need direct WebRTC or TURN. A production TURN deployment and cross-network validation remain outstanding. Packaged WorkOS sign-in and real account acceptance remain separate gates.
