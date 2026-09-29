#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'The iOS build requires macOS with full Xcode.' >&2
  exit 1
fi
if ! sdk="$(xcrun --sdk iphoneos --show-sdk-path 2>/dev/null)"; then
  echo 'The iPhoneOS SDK is missing. Install full Xcode and select it with xcode-select.' >&2
  exit 1
fi
if ! command -v wails3 >/dev/null; then
  echo 'Install the pinned Wails CLI: go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.18' >&2
  exit 1
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
app="$repo/apps/desktop-wails"
version="$(node -p "require('$app/package.json').version")"
archive="$app/bin/BetterComms-ios.a"
bundle="$app/bin/BetterComms.app"
binary="$bundle/BetterComms"
ipa="$app/bin/bettercomms-wails-$version-ios-arm64-adhoc.ipa"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# DAT 1.0.0 ships binary Swift frameworks. Pin both the tag and commit so a
# changed upstream tag cannot silently change what the iPhone archive embeds.
meta_sdk="${BETTERCOMMS_META_SDK_DIR:-$scratch/meta-wearables-dat-ios}"
if [[ -z "${BETTERCOMMS_META_SDK_DIR:-}" ]]; then
  git clone --quiet --depth 1 --branch 1.0.0 \
    https://github.com/facebook/meta-wearables-dat-ios.git "$meta_sdk"
elif [[ -n "$(git -C "$meta_sdk" status --porcelain)" ]]; then
  echo 'The cached Meta SDK must have a clean working tree.' >&2
  exit 1
fi
if [[ "$(git -C "$meta_sdk" rev-parse HEAD)" != "1f38beecba83c4c8b5e343540f9cd615323ab19a" ]]; then
  echo 'Unexpected Meta Wearables DAT 1.0.0 commit.' >&2
  exit 1
fi
meta_core="$meta_sdk/MWDATCore.xcframework/ios-arm64"
meta_camera="$meta_sdk/MWDATCamera.xcframework/ios-arm64"

# Wails beta.18 has no iOS media-permission delegate. Patch a disposable
# module copy so the packaged page gets only the system's native permission
# dialog, while navigated/untrusted pages keep WebKit's prompt.
wails_module="$(cd "$app" && go list -m -f '{{.Dir}}' github.com/wailsapp/wails/v3)"
cp -R "$wails_module" "$scratch/wails"
# Go's module cache is read-only; make the disposable copy removable by the
# EXIT trap after packaging.
chmod -R u+w "$scratch/wails"
python3 "$repo/scripts/patch-wails-ios-permissions.py" "$scratch/wails"
cp "$app/go.mod" "$scratch/build.mod"
cp "$app/go.sum" "$scratch/build.sum"
(cd "$app" && go mod edit -modfile="$scratch/build.mod" \
  -replace="github.com/wailsapp/wails/v3=$scratch/wails")

(cd "$repo" && npm run build)
staged="$app/frontend/dist"
find "$staged" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} +
cp -R "$repo/apps/web/dist/." "$staged/"

mkdir -p "$app/bin"
(
  cd "$app"
  wails3 ios overlay:gen -out build/ios/xcode/overlay.json -config build/config.yml
  wails3 ios xcode:gen -outdir build/ios/xcode -config build/config.yml
  export GOOS=ios GOARCH=arm64 CGO_ENABLED=1
  export CGO_CFLAGS="-isysroot $sdk -target arm64-apple-ios17.2 -miphoneos-version-min=17.2"
  export CGO_LDFLAGS="-isysroot $sdk -target arm64-apple-ios17.2"
  go build -buildmode=c-archive -modfile="$scratch/build.mod" -overlay build/ios/xcode/overlay.json \
    -tags production,ios -trimpath -buildvcs=false \
    -ldflags '-X main.bakedAPIOrigin=https://app.bettrcomms.com' \
    -o "$archive" .
)

xcrun --sdk iphoneos swiftc -target arm64-apple-ios17.2 -sdk "$sdk" \
  -parse-as-library -module-name BetterCommsMeta -F "$meta_core" \
  -emit-objc-header -emit-objc-header-path "$app/bin/BetterCommsMeta-Swift.h" \
  -c "$app/native/ios/meta_session_probe.swift" -o "$app/bin/meta_session_probe.o"

xcrun --sdk iphoneos clang -target arm64-apple-ios17.2 -isysroot "$sdk" \
  -fobjc-arc -fmodules -I "$scratch/wails/pkg/application" -I "$app/bin" \
  -F "$meta_core" -F "$meta_camera" \
  -c "$app/native/ios/meta_camera_ios.m" -o "$app/bin/meta_camera_ios.o"
xcrun --sdk iphoneos clang -target arm64-apple-ios17.2 -isysroot "$sdk" \
  -fobjc-arc -c "$app/native/ios/ios_call_audio.m" -o "$app/bin/ios_call_audio.o"
xcrun --sdk iphoneos clang -target arm64-apple-ios17.2 -isysroot "$sdk" \
  -fobjc-arc -fmodules -I "$scratch/wails/pkg/application" \
  -c "$app/native/ios/ios_app_screen.m" -o "$app/bin/ios_app_screen.o"

xcrun --sdk iphoneos clang -target arm64-apple-ios17.2 -isysroot "$sdk" \
  -fobjc-arc -fmodules -c "$app/native/ios/meta_video_encoder.m" -o "$app/bin/meta_video_encoder.o"

xcrun --sdk iphoneos clang -target arm64-apple-ios17.2 -isysroot "$sdk" \
  -F "$meta_core" -F "$meta_camera" \
  -framework Foundation -framework UIKit -framework WebKit \
  -framework Security -framework CoreFoundation -framework UniformTypeIdentifiers \
  -framework LocalAuthentication -framework UserNotifications -framework AVFoundation \
  -framework VideoToolbox -framework ReplayKit -framework CoreImage -framework CoreMedia -framework CoreVideo \
  -framework CoreLocation -framework CoreMotion -framework SystemConfiguration \
  -framework MWDATCore -framework MWDATCamera \
  -Wl,-rpath,@executable_path/Frameworks \
  -L "$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/iphoneos" \
  -L "$sdk/usr/lib/swift" -lswiftCore -lswift_Concurrency \
  -lresolv -o "$app/bin/BetterComms" \
  "$app/build/ios/xcode/main/main.m" "$app/bin/meta_camera_ios.o" "$app/bin/meta_video_encoder.o" \
  "$app/bin/ios_call_audio.o" "$app/bin/ios_app_screen.o" "$app/bin/meta_session_probe.o" \
  -Wl,-force_load,"$archive"

rm -rf "$bundle"
mkdir -p "$bundle"
cp "$app/bin/BetterComms" "$binary"
cp "$app/build/ios/xcode/main/Info.plist" "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable BetterComms' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSCameraUsageDescription string BetterComms uses your camera when you enable video.' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSMicrophoneUsageDescription string BetterComms uses your microphone when you join a call.' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSBluetoothAlwaysUsageDescription string BetterComms connects to your Meta AI glasses when you select their camera.' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSBluetoothPeripheralUsageDescription string BetterComms connects to your Meta AI glasses when you select their camera.' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSLocalNetworkUsageDescription string BetterComms connects to your Meta AI glasses over your local network.' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSBonjourServices array' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSBonjourServices:0 string _bonjour._tcp' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :UISupportedExternalAccessoryProtocols array' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :UISupportedExternalAccessoryProtocols:0 string com.meta.ar.wearable' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :UIBackgroundModes array' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :UIBackgroundModes:0 string bluetooth-central' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :UIBackgroundModes:1 string bluetooth-peripheral' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :UIBackgroundModes:2 string external-accessory' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :UIBackgroundModes:3 string audio' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :UIBackgroundModes:4 string processing' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes array' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0 dict' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleTypeRole string Editor' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLName string com.bettrcomms.ios' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string bettrcomms-meta' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :MWDAT dict' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :MWDAT:AppLinkURLScheme string bettrcomms-meta://' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :MWDAT:MetaAppID string 0' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :MWDAT:ClientToken string' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :MWDAT:TeamID string 764FPKS8YP' "$bundle/Info.plist"
# Local diagnostics can opt in without changing production logging defaults.
if [[ "${BETTERCOMMS_META_DEBUG:-0}" == 1 ]]; then
  /usr/libexec/PlistBuddy -c 'Add :MWDAT:Logging dict' "$bundle/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :MWDAT:Logging:Level string debug' "$bundle/Info.plist"
fi
/usr/libexec/PlistBuddy -c 'Add :MWDAT:Analytics dict' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :MWDAT:Analytics:OptOut bool true' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :MWDAT:CrashReporting dict' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :MWDAT:CrashReporting:OptOut bool true' "$bundle/Info.plist"
xcrun --sdk iphoneos ibtool --compile "$bundle/LaunchScreen.storyboardc" \
  "$app/build/ios/xcode/main/LaunchScreen.storyboard"

assets="$(mktemp -d)"
payload="$(mktemp -d)"
trap 'rm -rf "$assets" "$payload" "$scratch"' EXIT
xcrun --sdk iphoneos actool \
  --compile "$assets" --app-icon AppIcon --platform iphoneos \
  --minimum-deployment-target 15.0 --product-type com.apple.product-type.application \
  --target-device iphone --target-device ipad \
  --output-partial-info-plist "$bundle/assetcatalog_generated_info.plist" \
  "$app/build/ios/xcode/main/Assets.xcassets"
cp "$assets/Assets.car" "$bundle/Assets.car"
/usr/libexec/PlistBuddy -c "Merge $bundle/assetcatalog_generated_info.plist" "$bundle/Info.plist"
plutil -lint "$bundle/Info.plist"

mkdir -p "$bundle/Frameworks"
cp -R "$meta_core/MWDATCore.framework" "$bundle/Frameworks/"
cp -R "$meta_camera/MWDATCamera.framework" "$bundle/Frameworks/"
cp "$meta_sdk/LICENSE" "$bundle/MetaWearables-LICENSE.txt"
cp "$meta_sdk/NOTICE" "$bundle/MetaWearables-NOTICE.txt"
codesign --force --sign - "$bundle/Frameworks/MWDATCore.framework"
codesign --force --sign - "$bundle/Frameworks/MWDATCamera.framework"

# The artifact is a device-target IPA for a developer to re-sign with their
# own certificate and provisioning profile. Ad-hoc signing is not installable
# on a physical iPhone.
codesign --force --sign - --entitlements "$repo/scripts/BetterComms-ios.entitlements" "$bundle"
codesign --verify --deep --strict --verbose=2 "$bundle"
mkdir -p "$payload/Payload"
ditto "$bundle" "$payload/Payload/BetterComms.app"
rm -f "$ipa"
(cd "$payload" && zip -qry "$ipa" Payload)
unzip -tqq "$ipa"
echo "iOS device archive (re-sign before installing): $ipa"
