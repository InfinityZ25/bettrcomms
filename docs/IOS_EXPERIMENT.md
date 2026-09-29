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
packaged iPhone acceptance. An iOS app shell alone does not add screen sharing:
the reported iPhone Safari and Chrome browsers do not expose
`getDisplayMedia`. Capturing the iPhone display would need a separate native
ReplayKit broadcast implementation and device testing.

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
