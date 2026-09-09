# BetterComms Wails v3 host

A second desktop shell, alongside the Tauri 2 host in `apps/desktop`. It opens a
native window over the shared `apps/web` frontend and exposes a small generated
Wails service for window controls.

`apps/desktop` is unchanged and remains the only shell with native media.

## What this host does and does not do

Implemented here:

- a native window, frameless on Windows and Linux so the page draws the existing
  custom title bar, and decorated on macOS
- the shared frontend, served from an embedded copy of `apps/web/dist` in a
  build, or proxied live from the Vite dev server during development
- a validated API origin, using the same policy as the Tauri host
- an honest capability report, injected into the document before any bundle runs
- minimise, maximise/restore, and close through generated Wails v3 bindings
- native Windows non-client regions for caption dragging and custom caption
  buttons, including the `HTMAXBUTTON` route used by Windows 11 Snap Layouts

Not ported, and reported as unavailable:

| Capability | Tauri host | This host | What happens instead |
|---|---|---|---|
| Window/display capture | Windows Graphics Capture | none | browser `getDisplayMedia` |
| Process/system audio | Windows process loopback | none | browser display-capture audio |
| GPU microphone denoise | NVIDIA Audio Effects, DirectML DeepFilterNet | none | RNNoise, SpeexDSP, or DeepFilterNet WASM in the page |
| Native recording/export | H.264 remux to MP4, native Save As | none | `MediaRecorder` and browser export |
| Media permission IPC | WebView2 Profile4 | none | the webview's own permission handling |
| Global input hooks | keyboard and mouse hooks | none | foreground push-to-talk |
| Native overlays | camera overlay, visual copilot | none | in-app presentation |
| Packaged auth return | not implemented there either | none | same-origin sign-in only |

No parity with `apps/desktop` is claimed. `internal/desktop/capabilities_test.go`
fails if any of those rows is quietly promoted.

## Requirements

- Go 1.25 or newer
- The pinned Wails CLI, `v3.0.0-beta.18`, at `%USERPROFILE%\go\bin\wails3.exe`
- Its platform prerequisites (WebView2 on Windows); run `wails3 doctor`
- One network-enabled `go mod tidy` to produce `go.sum`

## Running it

From the repository root, in separate terminals:

```powershell
./scripts/start-api.ps1 -DevAuth
./scripts/start-desktop-wails.ps1
```

The runner starts Vite on 5173 if it is not already running, sets
`BETTERCOMMS_DEV_SERVER`, and runs the Go host against it. Frontend edits reload
without a Go rebuild.

Build:

```powershell
./scripts/build-desktop-wails.ps1 -ApiOrigin https://your-host.example
```

That regenerates the typed Wails bindings, builds `apps/web`, stages
`apps/web/dist` into `frontend/dist`, runs `go vet` and `go test`, then builds
with the pinned `wails3` CLI.

`Taskfile.yml` covers the same steps for `wails3 dev` and `wails3 build`.

## Layout

```
main.go                        Wails wiring: window, service, asset handler. No media code.
internal/desktop/origin.go     API-origin policy.
internal/desktop/capabilities.go  The capability and boot reports.
internal/desktop/assets.go     Embedded assets, dev proxy, boot-report injection.
frontend/dist/                 Staged copy of apps/web/dist. Not a fork; not committed.
```

Everything except `main.go` is free of Wails imports, so the security boundary
and the capability report are testable with `go test` alone.

## Frontend reuse

`apps/web` is the single frontend. This host never copies its source: development
proxies the running Vite server, and a build copies only `apps/web/dist` into
`frontend/dist` for `//go:embed`.

The frontend detects its host through `apps/web/src/desktop`. Native features
gate on `hasTauriNativeCommands()`, so they stay on their browser path here
rather than calling commands that do not exist.

## Security boundary and current limitation

- The registered Wails service exposes only five window operations. It exposes
  no shell, process, filesystem, auth, or media methods.
- Camera and microphone use the webview's native prompt policy. Geolocation,
  notifications, and clipboard-read requests are denied. Windows keeps only
  the autoplay/background-media Chromium flags already used by the Tauri host.
- The API origin must be HTTPS, or loopback HTTP in development, and must carry
  no credentials, path, query, or fragment. The page re-validates it before use.
- Packaged API routing is not implemented yet. The embedded frontend's relative
  `/api` calls receive an explicit 501; development through Vite is the usable
  scaffold path. Packaged authentication is not claimed.
