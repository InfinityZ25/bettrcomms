# BetterComms Wails v3 host

A second desktop shell beside Tauri, using the same React/Vite frontend in
`apps/web`. Wails v3.0.0-beta.18 is pinned. No better-gui port is used.

## Status

Native Windows capture, H.264 WebRTC, process audio, recording, Save As/conversion,
background push-to-talk, camera/copilot overlays and optional NVIDIA/DeepFilterNet
processing have Go implementations and shared frontend adapters. Passing module
tests is not full desktop acceptance. See [the completion ledger](../../docs/WAILS_COMPLETION.md)
for verified results and outstanding native, packaged and hardware gates.

The host embeds frontend assets, proxies HTTP/WebSocket API traffic through an
authenticated loopback service, and opens sign-in in the system browser. Windows
session persistence uses the OS credential store; other platforms lack persistence.

## Development

Use Go matching `go.mod`, the pinned CLI at
`%USERPROFILE%\go\bin\wails3.exe`, and Windows WebView2. Run `wails3 doctor`
to check prerequisites. Install frontend dependencies with root `npm ci`.

From the repository root, in separate terminals:

```powershell
./scripts/start-api.ps1 -DevAuth
./scripts/start-desktop-wails.ps1
```

Development authentication remains opt-in and loopback-only. The launcher uses
Vite on port 5173; frontend source is never duplicated.

## Windows build

```powershell
./scripts/build-desktop-wails.ps1
```

Optionally pass `-ApiOrigin https://your-host.example`; this HTTPS origin is
validated and linked into the executable, not left in the build machine's
environment. `bettercomms-wails.exe --print-build-info` prints non-secret build
metadata without opening a window or starting network/media services. An explicit
`BETTERCOMMS_API_ORIGIN` runtime override remains supported and validated.
The script stages model
assets, generates bindings, builds and embeds the frontend, runs Go vet/tests,
and builds the host. The build task stages pinned, hash-verified FFmpeg files:

```text
bin/
  bettercomms-wails.exe
  ffmpeg/
    ffmpeg.exe
    LICENSE
    SOURCE.txt
    setup.json
```

Keep this directory together. The runtime is resolved relative to the executable,
not the working directory. Preparation reuses the verified Tauri bundle or runs
the existing pinned preparation script, which can require a download. Optional
GPU audio runtimes still require explicit setup. Installer and release CI work
remain outstanding; this directory is not an installer.

Test the staged runtime without relying on the user's private installation:

```powershell
cd apps/desktop-wails
$env:BETTERCOMMS_TEST_BUNDLE_DIR = (Join-Path $PWD 'bin')
go test -count=1 -v ./internal/native/ffmpegsetup -run TestStagedBundle
```

From the repository root, `./scripts/test-wails-build-origin.ps1` checks rejected
origins and compiles a custom-origin binary, verifies it without environment
overrides, then restores the normal binary. The Windows CI job runs this check.

## Boundaries and remaining acceptance

- Sensitive media operations require a per-launch page token. File exports use
  native Save As and bounded opaque grants, not arbitrary paths from the page.
- API origins must be HTTPS, or loopback HTTP in development, without credentials,
  paths, queries or fragments. Proxy and native tokens are separate.
- Microphone/camera policy is set at window creation; unlike Tauri's per-origin
  permission IPC, Wails does not currently revoke it dynamically. OS privacy
  settings still apply.
- Packaged login, navigation/resource cleanup, interactive native UI and sustained
  hardware acceptance remain release gates.
- Existing Tauri recordings/preferences are not automatically imported. macOS
  packaging and acceptance remain outstanding.

Shared browser media, chat and calls remain in `apps/web`. Native modules live
in `internal/native`; host policy/auth/assets live in `internal/desktop`.
