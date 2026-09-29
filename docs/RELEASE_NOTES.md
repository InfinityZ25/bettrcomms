# BetterComms preview release notes

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

## Unreleased — Wails-only desktop build

The desktop app now builds solely from `apps/desktop-wails`. The removed desktop host, its JavaScript dependency, packaging workflow, and obsolete native test fixtures are no longer part of the repository. The shared frontend selects browser or Wails adapters from the validated desktop boot report. Windows builds stage the pinned FFmpeg runtime and model assets for Wails. macOS places native traffic lights over the app's own title area, bundles the BetterComms icon, ad hoc signs and verifies the Wails app, then provides one drag-to-Applications DMG per architecture. GitHub Actions wraps each DMG in an artifact ZIP. These builds remain unsigned by Developer ID and unnotarized; users may need Privacy & Security → Open Anyway.

The Wails native media implementations still require physical-device and packaged authentication acceptance. macOS uses webview capture where supported and does not claim Windows native capture, process audio, or GPU processing. See [desktop validation status](WAILS_COMPLETION.md).

Mobile browser calls now offer an in-call camera picker for sources the browser exposes. Choosing a source while video is off saves it for the next camera-on action; switching while video is on replaces only the camera without recapturing the microphone. If the selected camera cannot be opened, the current video stays live and the app reports that the device may be busy or unavailable. For browsers that cannot open two cameras at once, it suggests turning video off before switching. Direct Meta Ray-Ban camera streaming is not implemented in the browser client; it needs a native mobile integration and device acceptance testing.

On narrow screens, the conversations toggle opens a right-side drawer over the current view. The drawer takes two-thirds of the viewport, and selecting a room closes it. The Friends dialog stays within the visible phone viewport and scrolls its contents when the list is long.

## Unreleased — messaging basics

Direct and room conversations support persistent unread and mention badges, mark-as-read, paginated history, authorized full-text search with conversation and author filters, own-message edit and delete, replies, and emoji reactions. Changes synchronize through the event stream, and reconnect reconciles history. Migration 003 preserves existing content. See [messaging controls and limits](MESSAGING.md).

## Current browser and service limits

Browser microphone, camera, and screen sharing use WebRTC, with synthetic-media browser tests against the real API/database. These tests do not prove native capture, physical devices, or external-network connectivity. The Go service has an encrypted microphone-only WebSocket fallback; camera, screen, and shared audio still need direct WebRTC or TURN. A production TURN deployment and cross-network validation remain outstanding. Packaged WorkOS sign-in and real account acceptance remain separate gates.
