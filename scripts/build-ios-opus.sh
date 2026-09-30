#!/usr/bin/env bash
set -euo pipefail
# A small, pinned native encoder for ReplayKit app audio. No runtime download.
repo="$(cd "$(dirname "$0")/.." && pwd)"
destination="${1:-$repo/.local/build-deps/opus-ios-1.5.2}"
if [[ -f "$destination/lib/libopus.a" && -f "$destination/include/opus/opus.h" && -f "$destination/COPYING" ]]; then
  exit 0
fi
sdk="$(xcrun --sdk iphoneos --show-sdk-path)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
curl --fail --location --retry 3 --silent --show-error \
  https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz -o "$scratch/opus.tar.gz"
actual="$(shasum -a 256 "$scratch/opus.tar.gz" | cut -d ' ' -f 1)"
if [[ "$actual" != 65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1 ]]; then
  echo 'Opus source checksum mismatch.' >&2
  exit 1
fi
tar -xzf "$scratch/opus.tar.gz" -C "$scratch"
cd "$scratch/opus-1.5.2"
CC="$(xcrun --sdk iphoneos --find clang)" \
CFLAGS="-O2 -isysroot $sdk -target arm64-apple-ios17.2 -fapplication-extension" \
LDFLAGS="-isysroot $sdk -target arm64-apple-ios17.2" \
./configure --host=aarch64-apple-darwin --prefix="$destination" \
  --disable-shared --enable-static --disable-extra-programs --disable-doc \
  --disable-intrinsics --disable-rtcd
make -j "$(sysctl -n hw.ncpu)"
make install
cp COPYING "$destination/COPYING"
