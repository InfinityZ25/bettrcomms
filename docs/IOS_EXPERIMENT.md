# Experimental iOS package

Wails v3.0.0-beta.18 includes an experimental iOS host. The repository's iOS
workflow builds an `iphoneos` arm64 `.ipa` without Apple signing credentials.
The artifact is ad hoc signed for packaging checks and **cannot be installed
on an iPhone as downloaded**. It needs an Apple Development or Distribution
certificate, an App ID, and a provisioning profile for
`com.bettrcomms.ios`. Change the bundle ID in
`apps/desktop-wails/build/config.yml` if your account uses a different App ID.
After re-signing, install through Xcode or Apple Configurator. The generated
Xcode project under `apps/desktop-wails/build/ios/xcode` can instead use
Xcode's automatic signing once you have full Xcode locally.

To build locally, install full Xcode, select it with `xcode-select`, accept its
license, and install the iOS platform and simulator from Xcode Settings.
Apple's standalone Command Line Tools do not contain the iPhoneOS SDK. Install
the pinned CLI with
`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.18`, run
`npm ci`, then run `bash scripts/package-desktop-wails-ios.sh` from the repo
root. GitHub Actions can build the same ad hoc IPA without local Xcode via
**Experimental Wails iOS build**.

This package is a build experiment, not a release claim. The desktop host's
authentication, API routing, and media service lifecycle have not passed
packaged iPhone acceptance. iPhone Safari and Chrome do not expose the browser
`getDisplayMedia` picker. The native iPhone app now offers **Share BetterComms
screen** using ReplayKit's in-app capture and a bounded video bridge into the
existing WebRTC screen track. This shares the foreground app only, without
system audio. Sharing other apps or the entire phone requires a ReplayKit
broadcast extension and an independent sender that survives app suspension.
The in-app path still needs signed-device sender, viewer, stop, and background
acceptance; it must not be advertised as working until those checks pass.

The experimental Ray-Ban Meta camera path uses Meta Wearables Device Access
Toolkit 1.0.0 in the iOS host. It is available in the in-call camera picker and
camera settings preview on this native build only. Pair Gen 1 or Gen 2 glasses
in the Meta AI app and enable Developer Mode there; the first selection may redirect to Meta AI for
registration or glasses-camera consent. The native host sends bounded JPEG
frames to the packaged page, which publishes them as a canvas camera track.
This is a foreground-only proof of the media bridge. It needs physical glasses
acceptance for registration, permission callback, WebKit canvas publication,
remote viewing, switching, and teardown before calling it working. The app
does not claim background glasses video, because DAT raw frames and WKWebView
publishing stop when the iPhone backgrounds.

During an iPhone call, the host also activates a native play-and-record audio
session with iOS's audio background mode, then deactivates it on leave, error,
or shutdown. This is the required platform setup for continued two-way audio;
it does not prove that the WKWebView WebRTC graph stays active after the app
backgrounds. Test a signed device with the screen locked and with another app
foregrounded before claiming background calling works.

The iOS build uses Wails' UIKit browser opener for WorkOS sign-in and reports
native window chrome to the shared frontend, so desktop minimize/maximize/close
controls are not drawn on iPhone. A signed build opened on a physical iPhone
and reached a call; packaged authentication and the current media changes
still need complete device acceptance. The sign-in panel also exposes the
confirmation link while a pairing is pending.

The iOS host enables inline video so call tiles stay inside the app and
disables the root webview's bounce. Packaging patches a temporary copy of the
pinned Wails beta.18 module so the WKWebView itself fills the iPhone screen;
the page uses `viewport-fit=cover` and safe-area padding to keep controls clear
of system UI. The same patch grants WebKit media access only to the packaged
top-level `wails://localhost` page after iOS handles app-level camera/mic
permission. Other origins keep WebKit's normal prompt. This needs signed-device
verification; changing Wails versions intentionally fails the patch until its
anchors are reviewed.
