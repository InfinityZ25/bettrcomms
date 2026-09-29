#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <ad-hoc.ipa> <development.mobileprovision> <codesign identity> <signed.ipa>" >&2
  exit 2
fi

archive="$1"
profile="$2"
identity="$3"
output="$4"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

security cms -D -i "$profile" > "$scratch/profile.plist"
for entitlement in \
  com.apple.developer.networking.HotspotConfiguration \
  com.apple.developer.networking.wifi-info; do
  if [[ "$(/usr/libexec/PlistBuddy -c "Print :Entitlements:$entitlement" "$scratch/profile.plist" 2>/dev/null)" != true ]]; then
    echo "The provisioning profile does not grant $entitlement. Enable the matching App ID capability and regenerate the profile." >&2
    exit 1
  fi
done

plutil -extract Entitlements xml1 -o "$scratch/entitlements.plist" "$scratch/profile.plist"
unzip -q "$archive" -d "$scratch/unpacked"
bundle="$scratch/unpacked/Payload/BetterComms.app"
if [[ ! -d "$bundle" ]]; then
  echo "The IPA has no Payload/BetterComms.app." >&2
  exit 1
fi
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Info.plist")"
application_id="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$scratch/profile.plist")"
if [[ "$application_id" != *".$bundle_id" ]]; then
  echo "The provisioning profile is for a different App ID." >&2
  exit 1
fi

cp "$profile" "$bundle/embedded.mobileprovision"
# Xcode debug builds place executable code in an app-local debug dylib.
# Sign nested libraries before their containing frameworks and app bundle.
while IFS= read -r -d '' library; do
  codesign --force --sign "$identity" --timestamp=none "$library"
done < <(find "$bundle" -type f -name '*.dylib' -print0)
for framework in "$bundle"/Frameworks/*.framework; do
  [[ -d "$framework" ]] || continue
  codesign --force --sign "$identity" --timestamp=none "$framework"
done
codesign --force --sign "$identity" --timestamp=none \
  --entitlements "$scratch/entitlements.plist" "$bundle"
codesign --verify --deep --strict "$bundle"

output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"
rm -f "$output"
(cd "$scratch/unpacked" && zip -qr -X "$output" Payload)
unzip -tqq "$output"
echo "Signed iOS device archive: $output"
