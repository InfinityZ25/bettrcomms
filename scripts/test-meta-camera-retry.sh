#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
xcrun --sdk macosx clang -fobjc-arc -framework Foundation \
  -I "$repo/apps/desktop-wails/native/ios" \
  "$repo/tests/native/meta_camera_retry_test.m" -o "$scratch/meta-camera-retry-test"
"$scratch/meta-camera-retry-test"
xcrun --sdk macosx clang -Wall -Wextra -Werror \
  -I "$repo/apps/desktop-wails/native/ios" \
  "$repo/tests/native/meta_camera_watchdog_test.c" -o "$scratch/meta-camera-watchdog-test"
"$scratch/meta-camera-watchdog-test"
