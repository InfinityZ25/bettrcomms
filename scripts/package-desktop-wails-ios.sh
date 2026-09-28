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

# Wails beta.18 has no iOS media-permission delegate. Patch a disposable
# module copy so the packaged page gets only the system's native permission
# dialog, while navigated/untrusted pages keep WebKit's prompt.
wails_module="$(cd "$app" && go list -m -f '{{.Dir}}' github.com/wailsapp/wails/v3)"
cp -R "$wails_module" "$scratch/wails"
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
  export CGO_CFLAGS="-isysroot $sdk -target arm64-apple-ios15.0 -miphoneos-version-min=15.0"
  export CGO_LDFLAGS="-isysroot $sdk -target arm64-apple-ios15.0"
  go build -buildmode=c-archive -modfile="$scratch/build.mod" -overlay build/ios/xcode/overlay.json \
    -tags production,ios -trimpath -buildvcs=false \
    -ldflags '-X main.bakedAPIOrigin=https://app.bettrcomms.com' \
    -o "$archive" .
)

xcrun --sdk iphoneos clang -target arm64-apple-ios15.0 -isysroot "$sdk" \
  -framework Foundation -framework UIKit -framework WebKit \
  -framework Security -framework CoreFoundation -framework UniformTypeIdentifiers \
  -framework LocalAuthentication -framework UserNotifications -framework AVFoundation \
  -framework CoreLocation -framework CoreMotion -framework SystemConfiguration \
  -lresolv -o "$app/bin/BetterComms" \
  "$app/build/ios/xcode/main/main.m" -Wl,-force_load,"$archive"

rm -rf "$bundle"
mkdir -p "$bundle"
cp "$app/bin/BetterComms" "$binary"
cp "$app/build/ios/xcode/main/Info.plist" "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable BetterComms' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSCameraUsageDescription string BetterComms uses your camera when you enable video.' "$bundle/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSMicrophoneUsageDescription string BetterComms uses your microphone when you join a call.' "$bundle/Info.plist"
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

# The artifact is a device-target IPA for a developer to re-sign with their
# own certificate and provisioning profile. Ad-hoc signing is not installable
# on a physical iPhone.
codesign --force --sign - "$bundle"
codesign --verify --deep --strict --verbose=2 "$bundle"
mkdir -p "$payload/Payload"
ditto "$bundle" "$payload/Payload/BetterComms.app"
rm -f "$ipa"
(cd "$payload" && zip -qry "$ipa" Payload)
unzip -tqq "$ipa"
echo "iOS device archive (re-sign before installing): $ipa"
