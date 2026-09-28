#!/usr/bin/env bash
set -euo pipefail

# Repackage an unsigned Tauri DMG whose linker-signed executable does not seal
# the app bundle. This uses a local ad hoc signature, not a Developer ID.
if [[ "$(uname -s)" != Darwin || $# -ne 2 ]]; then
  echo 'Usage (on macOS): repair-tauri-macos-dmg.sh INPUT.dmg OUTPUT.dmg' >&2
  exit 2
fi
input="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
output="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
if [[ ! -f "$input" || "$input" == "$output" || -e "$output" ]]; then
  echo 'Input must exist; output must be a new, different file.' >&2
  exit 2
fi

scratch="$(mktemp -d)"
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then hdiutil detach "$scratch/mount" >/dev/null; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir -p "$scratch/mount" "$scratch/staging"
hdiutil attach -readonly -nobrowse -mountpoint "$scratch/mount" "$input" >/dev/null
mounted=true
ditto "$scratch/mount/BetterComms.app" "$scratch/staging/BetterComms.app"
if [[ -f "$scratch/mount/.VolumeIcon.icns" ]]; then
  ditto "$scratch/mount/.VolumeIcon.icns" "$scratch/staging/.VolumeIcon.icns"
fi
ln -s /Applications "$scratch/staging/Applications"
hdiutil detach "$scratch/mount" >/dev/null
mounted=false

codesign --force --sign - --identifier com.bettercomms.desktop "$scratch/staging/BetterComms.app"
codesign --verify --deep --strict --verbose=2 "$scratch/staging/BetterComms.app"
hdiutil create -volname BetterComms -srcfolder "$scratch/staging" -format UDZO "$output" >/dev/null
hdiutil verify "$output" >/dev/null
echo "Ad hoc signed preview: $output"
