#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
include="$repo/apps/desktop-wails/native/ios/broadcast"
xcrun --sdk macosx clang -I "$include" "$repo/tests/native/broadcast_timing_test.c" -o "$scratch/timing"
"$scratch/timing"
# Host-side converter/codec validation; physical ReplayKit delivery is separate.
opus="$(brew --prefix opus)"
xcrun --sdk macosx clang -fobjc-arc -fmodules -I "$include" -I "$opus/include" \
  -L "$opus/lib" -lopus -framework AVFoundation -framework CoreMedia \
  "$include/BroadcastAudio.m" "$repo/tests/native/broadcast_audio_test.m" -o "$scratch/audio"
"$scratch/audio"
