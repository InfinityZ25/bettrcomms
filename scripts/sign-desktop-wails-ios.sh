#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "Usage: $0 <ad-hoc.ipa> <development.mobileprovision> <codesign identity> <signed.ipa> [broadcast.mobileprovision]" >&2
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
broadcast="$bundle/PlugIns/BetterCommsBroadcast.appex"
if [[ -d "$broadcast" ]]; then
  if [[ -z "${5:-}" ]]; then
    echo 'This archive includes screen broadcasting. Supply its development profile as the fifth argument.' >&2
    exit 1
  fi
  security cms -D -i "$5" > "$scratch/broadcast-profile.plist"
  python3 - "$scratch/profile.plist" "$scratch/broadcast-profile.plist" <<'PY'
import plistlib, sys
profiles = []
for path in sys.argv[1:]:
    with open(path, 'rb') as file:
        profiles.append(plistlib.load(file))
host, extension = profiles
group = 'group.com.bettrcomms.ios.broadcast'
for profile in profiles:
    if group not in profile['Entitlements'].get('com.apple.security.application-groups', []):
        sys.exit('Both profiles must grant the BetterComms broadcast App Group.')
if host['TeamIdentifier'] != extension['TeamIdentifier']:
    sys.exit('Host and broadcast profiles must belong to the same team.')
prefix = host['Entitlements']['application-identifier'].rsplit('com.bettrcomms.ios', 1)[0]
if extension['Entitlements']['application-identifier'] != prefix + 'com.bettrcomms.ios.broadcast':
    sys.exit('The extension profile has the wrong App ID.')
if not set(host.get('ProvisionedDevices', [])).issubset(extension.get('ProvisionedDevices', [])):
    sys.exit('The extension profile must include the host profile\'s devices.')
PY
  cp "$5" "$broadcast/embedded.mobileprovision"
  plutil -extract Entitlements xml1 -o "$scratch/broadcast-entitlements.plist" "$scratch/broadcast-profile.plist"
  codesign --force --sign "$identity" --timestamp=none \
    --entitlements "$scratch/broadcast-entitlements.plist" "$broadcast"
fi
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
