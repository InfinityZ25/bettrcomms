#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
app="$repo/apps/desktop-wails"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
ndk="${ANDROID_NDK_HOME:-$sdk/ndk/28.2.13676358}"
mode="${ANDROID_BUILD_MODE:-debug}"
architectures="${ANDROID_ARCHS:-arm arm64}"
if [[ -z "$sdk" || ! -d "$ndk" ]]; then
  echo 'Set ANDROID_HOME; install platforms;android-36, build-tools;36.0.0 and ndk;28.2.13676358 with sdkmanager.' >&2
  exit 1
fi
case "$(uname -s)" in
  Darwin) host=darwin-x86_64 ;;
  Linux) host=linux-x86_64 ;;
  *) echo 'Build with Linux/macOS or WSL.' >&2; exit 1 ;;
esac
case "$mode" in
  debug) tasks=(assembleStandardDebug assembleMetaDebug testStandardDebugUnitTest testMetaDebugUnitTest lintStandardDebug lintMetaDebug); suffix=debug; tags=production ;;
  release)
    for key in ANDROID_KEYSTORE_FILE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD ANDROID_VERSION_CODE; do
      if [[ -z "${!key:-}" ]]; then echo "Release builds require $key." >&2; exit 1; fi
    done
    tasks=(assembleStandardRelease assembleMetaRelease bundleStandardRelease bundleMetaRelease); suffix=release; tags=production ;;
  *) echo 'ANDROID_BUILD_MODE must be debug or release.' >&2; exit 1 ;;
esac
[[ "${ANDROID_VERSION_CODE:-1}" =~ ^[1-9][0-9]*$ ]] || { echo 'Version code must be a positive integer.' >&2; exit 1; }
export ANDROID_HOME="$sdk"
export ANDROID_ARCHS="$architectures"
(cd "$app" && go mod download github.com/wailsapp/wails/v3)
module="$(cd "$app" && go list -m -f '{{.Dir}}' github.com/wailsapp/wails/v3)"
[[ -d "$module/internal/commands/build_assets/android" ]] || { echo 'Pinned Wails Android template was not downloaded.' >&2; exit 1; }
python3 "$repo/scripts/verify-android-wrapper.py"
python3 "$repo/scripts/prepare-wails-android.py" "$module" "$app/android/generated"
(cd "$repo" && npm run build)
mkdir -p "$app/frontend/dist" "$app/bin"
find "$app/frontend/dist" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} +
cp -R "$repo/apps/web/dist/." "$app/frontend/dist/"
toolchain="$ndk/toolchains/llvm/prebuilt/$host/bin"
for arch in $architectures; do
  case "$arch" in
    arm64) abi=arm64-v8a; triple=aarch64-linux-android ;;
    arm) abi=armeabi-v7a; triple=armv7a-linux-androideabi ;;
    amd64) abi=x86_64; triple=x86_64-linux-android ;;
    *) echo "Unsupported Android architecture: $arch" >&2; exit 1 ;;
  esac
  mkdir -p "$app/android/generated/jniLibs/$abi"
  (cd "$app" && GOOS=android GOARCH="$arch" GOARM=7 CGO_ENABLED=1 \
    CC="$toolchain/${triple}26-clang" CXX="$toolchain/${triple}26-clang++" \
    CGO_LDFLAGS='-Wl,-z,max-page-size=16384' \
    go build -buildmode=c-shared -tags "$tags" -trimpath -buildvcs=false \
      -ldflags '-s -w -checklinkname=0 -X main.bakedAPIOrigin=https://app.bettrcomms.com' \
      -o "android/generated/jniLibs/$abi/libwails.so" .)
done
(cd "$app/android" && ./gradlew --no-daemon "${tasks[@]}")
version="$(node -p "require('$app/package.json').version")"
for flavor in standard meta; do
  cp "$app/android/app/build/outputs/apk/$flavor/$suffix/app-$flavor-$suffix.apk" "$app/bin/bettercomms-$version-android-$flavor-$suffix.apk"
  if [[ "$mode" == release ]]; then
    cp "$app/android/app/build/outputs/bundle/${flavor}Release/app-$flavor-release.aab" "$app/bin/bettercomms-$version-android-$flavor-release.aab"
  fi
  echo "Android package: $app/bin/bettercomms-$version-android-$flavor-$suffix.apk"
done
