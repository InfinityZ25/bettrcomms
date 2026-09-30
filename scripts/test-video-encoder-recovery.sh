#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
xcrun --sdk macosx clang -framework VideoToolbox \
  -I "$repo/apps/desktop-wails/native/ios" \
  "$repo/tests/native/video_encoder_recovery_test.c" -o "$scratch/video-encoder-recovery-test"
"$scratch/video-encoder-recovery-test"
