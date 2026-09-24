#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Build the macOS app on macOS.' >&2
  exit 1
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
app="$repo/apps/desktop-wails"
version="$(node -p "require('$app/package.json').version")"
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo 'Unsupported macOS architecture.' >&2; exit 1 ;;
esac

bundle="$app/bin/BetterComms Wails.app"
binary="$bundle/Contents/MacOS/bettercomms-wails"
archive="$app/bin/bettercomms-wails-$version-macos-$arch.zip"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"

(
  cd "$app"
  CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=15.0 go build -trimpath -tags production \
    -ldflags '-X main.bakedAPIOrigin=https://app.bettrcomms.com' \
    -o "$binary" .
)
"$binary" --print-build-info | node -e '
let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => {
  const info=JSON.parse(data);
  if(info.version !== process.argv[1] || info.apiOrigin !== "https://app.bettrcomms.com") process.exit(1);
});' "$version-wails"

cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.bettrcomms.wails</string>
  <key>CFBundleName</key><string>BetterComms Wails</string>
  <key>CFBundleDisplayName</key><string>BetterComms</string>
  <key>CFBundleExecutable</key><string>bettercomms-wails</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>BetterComms uses your microphone when you join a call.</string>
  <key>NSCameraUsageDescription</key><string>BetterComms uses your camera when you enable video.</string>
</dict></plist>
PLIST
cp "$app/build/appicon.png" "$bundle/Contents/Resources/appicon.png"
plutil -lint "$bundle/Contents/Info.plist"
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$archive"
echo "macOS archive: $archive"
