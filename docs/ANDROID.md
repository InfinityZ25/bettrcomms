# Android preview

BetterComms uses the same React/Vite frontend and Wails v3 Go host on Android.
This is an experimental native package, not a remote website shortcut. Android
hardware acceptance remains a release gate.

## Install variants

| APK | Minimum Android | Glasses SDK |
| --- | --- | --- |
| `standard` | Android 8 (API 26) | None; the Ray-Ban camera option is hidden |
| `meta` | Android 12 (API 31) | Meta Wearables DAT 1.0.0 |

Both use `com.bettrcomms.android`; switching flavors replaces the installed app
and retains its data when signed with the same key. Check the phone's Android
version in Settings before choosing an APK. In particular, an older Galaxy A10
may need the standard flavor. The build includes 32-bit ARM and arm64 for phones,
plus x86_64 in CI for emulators.

The [Android workflow](https://github.com/InfinityZ25/bettrcomms/actions/workflows/android-experimental.yml)
builds both development APKs on relevant pull requests and changes to `main`.
Download the artifact, extract it, and send the appropriate APK to the tester.
They must allow installation from the app used to open the APK. These are debug
packages; APKs from different machines/CI runs can have different signing keys,
so an update may require uninstalling first, which erases local sessions.

## Local build

Install Go 1.26, Node 24, JDK 21, the Android command-line SDK and these packages:

```sh
sdkmanager 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0' 'ndk;28.2.13676358'
npm ci
export ANDROID_HOME=/path/to/android-sdk
export JAVA_HOME=/path/to/jdk-21
ANDROID_ARCHS='arm arm64 amd64' npm run build:android
```

The default local build includes ARM and arm64. Output is in
`apps/desktop-wails/bin/bettercomms-<version>-android-<flavor>-debug.apk`.
The script builds the frontend, stages the pinned Wails Java/JNI host, compiles
Go shared libraries, and runs Gradle assembly, both flavors' unit tests and lint.
Android Studio can open `apps/desktop-wails/android` after staging. Re-run the
script after Go/frontend changes; Gradle alone does not rebuild embedded assets.

With a disposable emulator running and the debug APK installed, run
`ANDROID_HOME=/path/to/android-sdk node scripts/test-android-emulator.mjs standard`
(or `meta`). This checks the actual native host, CSP, binding authorization,
MediaProjection consent, a 720×1280 H.264 WebRTC receiver, background frames and
stop cleanup, including cancelling a picker without ending a live share and
stopping a share while backgrounded with call audio still active. Run
`./gradlew connectedStandardDebugAndroidTest` from the Android directory for
the rejected-foreground-service-start regression on a disposable emulator.
The smoke script is restricted to emulator serials and uses no real account.
These checks do not prove physical microphones/cameras/glasses or cross-network
connectivity. Android itself can end screen projection on locking the device.

```sh
adb install -r apps/desktop-wails/bin/bettercomms-0.1.19-android-standard-debug.apk
adb shell am start -n com.bettrcomms.android/com.wails.app.MainActivity
```

Native Go's Pion network dependency currently requires `-checklinkname=0` on
Android; the flag is scoped to this build. NDK r28c plus 16 KB linker/packaging
alignment is used for Android's page-size requirements. Java namespace
`com.wails.app` is required by Wails' JNI symbols and is distinct from the app ID.

## Native boundary

- Packaged UI is served at `https://wails.localhost`, with the existing strict
  content policy injected into HTML because Wails' Android asset loader does
  not preserve HTTP response headers. External navigation opens the system
  browser; native capture bindings require the host's per-launch page token.
- Authentication uses the existing browser sign-in/pairing flow and Go API
  proxy. Session credentials persist in Android Keystore-backed encrypted
  preferences, not page storage. Backups and device transfer are disabled.
- Camera/microphone prompts are granted only to the packaged origin after
  Android runtime permission checks. Android owns system-bar and keyboard
  insets; page zoom and WebView overscroll are disabled. System back gestures
  use AndroidX navigation and preserve an active call when returning home.
- Call audio uses Android communication mode/audio focus and a microphone
  foreground service after permission is granted. Phone camera/microphone
  capture and WebRTC audio transport still use WebView APIs. This does **not**
  establish uninterrupted background calls or background phone-camera video.
- Screen sharing uses a fresh MediaProjection system consent prompt, a typed
  foreground service, MediaCodec H.264 and the Go native WebRTC sender. Screen
  pixels do not cross JavaScript/canvas. The same sender supplies local preview
  and remote peers. Stop/error/consent cancellation/reload release native
  capture, encoder, service and sender resources. Protected content cannot be
  captured. The current encoder uses a fixed 720×1280 portrait buffer;
  landscape content is letterboxed, and negotiated resizing remains a follow-up.
  System/app audio capture is not implemented in this preview.
- The Meta flavor registers through Meta AI, checks SDK camera permission and
  starts one native device session. HEVC frames are decoded into explicit YUV
  planes and encoded to browser-compatible H.264 for the existing Go sender;
  only a reduced-rate preview crosses the WebView. Actual glasses connection,
  video quality and background streaming require physical-device acceptance.
  Desktop D-Bus notifications, tray features and native desktop DSP do not
  provide Android notifications or Android DSP.

## Meta configuration

Install Meta AI, pair compatible glasses, and enable their Developer Mode for
development testing. The official DAT sample permits empty application ID and
client token in Developer Mode. Production use requires registration in
Meta's Wearables Developer Center and its distribution requirements. Build
configuration accepts `BETTERCOMMS_META_ANDROID_APP_ID` and
`BETTERCOMMS_META_ANDROID_CLIENT_TOKEN`; never put WorkOS/TURN credentials in
these or any `VITE_` variable. SDK analytics/crash reporting are opted out.

The SDK license and platform constraints are in the
[official DAT Android repository](https://github.com/facebook/meta-wearables-dat-android).

## Release signing

For APKs/AABs signed with your stable Android release key, set
`ANDROID_BUILD_MODE=release`, an increasing `ANDROID_VERSION_CODE`, and these
private environment variables: `ANDROID_KEYSTORE_FILE`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
Release mode refuses to substitute a debug key. Keep keystores/passwords outside
Git; a future Play distribution workflow should inject them from CI secrets.
This PR does not publish to Google Play or create a production signing key.

## Device acceptance before release

Test on the actual older Samsung and an Android 12+ glasses phone:

1. Install, sign in through the system browser, force-stop and relaunch; verify
   the session persists and sign-out removes it.
2. Deny/retry camera/microphone permissions. Verify calls in both directions,
   phone cameras, wired/Bluetooth routing, Messages navigation and background
   audio. Do not infer these from a browser or emulator test.
3. Share the whole screen and a selected app where supported. Verify a remote
   participant receives video after switching apps, Android's stop control
   ends capture, leaving the call cancels an outstanding picker, and no service
   or sharing survives stop/reload/disconnect.
4. On the Meta flavor, test both generations of glasses, authorization returning
   from Meta AI, repeated starts/stops, forced app closure/relaunch, background
   operation, network changes and remote video/recording quality.

Phone-native Camera2/WebRTC capture, native audio transport, playback capture,
Android notification delivery and release-store compliance remain follow-up
work. The web and iOS implementations retain their existing platform paths.
