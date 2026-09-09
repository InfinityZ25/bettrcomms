# Tauri 2 to Wails v3 migration

Status: initial architecture, September 2026. This describes what exists in the
repository now. It is not a claim that the Wails host replaces the Tauri host.

## Shape of the migration

`apps/desktop` (Tauri 2) is untouched and remains the only shell with native
capture, native audio processing, native recording, global input, and overlays.
`apps/desktop-wails` is a new sibling: a Wails v3 window over the same frontend,
with none of that native code.

Three decisions shape it.

**One frontend, not a copy.** `apps/web` stays the single source. Development
proxies the running Vite server; a build stages only `apps/web/dist` for
`//go:embed`. There is no second copy of the UI to keep in step.

**No better-gui.** The Tauri host's window plugin is not ported. The Wails
window is created frameless where the page draws its own title bar, and the host
publishes the same `WindowControlsState` shape the plugin publishes, inside its
boot report. `windowControls.ts` accepts either source, so the title bar works
on both hosts without a second implementation.

On Windows the Wails host enables both `NonClientRegionSupport` and the
experimental `WebView2CompositionHosting` mode. The title area is a native
caption region, and the HTML buttons map to `HTMINBUTTON`, `HTMAXBUTTON`, and
`HTCLOSE`. This restores native hit testing and Windows 11 Snap Layouts on the
custom maximize button without porting `better-gui`.

**Native Wails services, generated at build time.** Window commands are a small
`application.NewService` surface. `wails3 generate bindings` writes its typed
client under `apps/web/src/desktop/wailsbindings`; the bridge imports that
module only after it has positively detected Wails. Browser and Tauri builds
therefore share the source tree without executing the Wails runtime.

## The dual-runtime frontend bridge

`apps/web/src/desktop` is the single place that answers "which host is this".

```ts
import { getDesktopRuntime, hasTauriNativeCommands, hasDesktopCapability } from '@/desktop';
```

- `getDesktopRuntime()` returns `'tauri' | 'wails' | 'browser'`, synchronously.
  Wails is detected from the boot report this host injects into the document
  before any bundle runs; Tauri from its own marker. Neither is guessed from the
  user agent, which a webview shares with a browser.
- `isDesktopShell()` is for shell chrome — the title bar, window controls.
- `hasTauriNativeCommands()` is for features. Every native media adapter lives
  in the Tauri host alone, so feature code gates on this and stays on its
  browser path everywhere else.
- `hasDesktopCapability(name)` and `describeCapabilityFallback(name)` drive user
  copy: what this host can do, and what happens instead when it cannot.

The boot report is validated on read, not trusted. A malformed report is
discarded whole, and the API origin inside it is re-checked against the same
policy the host applied, because that value decides where session material is
sent.

Existing native modules were left calling `isTauri()`. That already evaluates
false under Wails, so each one takes its browser fallback with no change. The
new module is what makes the situation *reportable* rather than merely silent.

## Capability reporting

Both hosts report `implemented` / `experimental` / `unavailable` per capability,
with a reason and, when unavailable, the fallback in use. The Wails host reports
every native capability `unavailable`; `capabilities_test.go` fails if one is
promoted without an acceptance test on that host. A passing Tauri test is not
evidence for the Wails host.

The connection diagnostic report now carries the runtime summary, so a report
from the Wails host cannot be read as if it came from the Tauri host's native
paths. The summary carries states and platform strings only, with no
identifiers.

## Security boundary

Carried over from the Tauri host, and tested:

- The API origin must be HTTPS, or loopback HTTP in a development build, with no
  credentials, path, query, or fragment. `ReleaseOrigin` is byte-identical to
  the Rust host's `RELEASE_ORIGIN`.
- The Wails service surface contains only five window methods: minimise,
  maximise/restore, close, and two state reads. No shell, process, filesystem,
  auth, or media service is registered.
- Camera and microphone use `PermissionDefault` so Windows/macOS show their
  native prompt; geolocation, notifications, and clipboard read are denied.
- The boot report is injected as a JSON string parsed by `JSON.parse`, with
  `<`, `>`, and `&` escaped, so no value in it can close the script element.

## Remaining gaps

Ordered roughly by what blocks the most.

1. **No native media at all.** Capture, process audio, GPU denoisers, native
   recording and export, permission IPC, global input, and both overlays are
   absent. Each is a separate port with its own acceptance gate. Until then the
   Wails host is a browser client in a native window.
2. **Packaged API routing is not implemented.** The embedded frontend still
   uses relative `/api` URLs. The asset handler returns an explicit 501 instead
   of HTML for those requests, but packaged auth and API calls are not usable
   until routing is designed and tested. Development uses the existing Vite
   proxy and is the supported path for this scaffold.
3. **No packaging, icons, signing, or installer.** `wails3 build` produces an
   unbranded executable. No macOS or Linux behaviour has been exercised.
4. **No authentication return.** Same position as the Tauri host: no deep link,
   no loopback handoff, no OS-protected storage. Sign-in works only where the
   page can reach the API origin directly.
5. **No end-to-end run.** The host has not completed an interactive acceptance
   pass in this workspace, so
   nothing here establishes that the window opens, that the frontend loads
   inside it, or that bindings respond in a real webview.
6. **Composition hosting needs physical-pointer acceptance.** Its compile and
   DOM contracts are covered, but hover, press/leave routing, Snap Layouts,
   focus, DPI changes, resizing, and media rendering still require an
   interactive Windows/WebView2 pass.

## Validation

Validated on Windows with Wails v3.0.0-beta.18: generated bindings (one service,
five methods), `go test ./...`, `go vet ./...`, `go build ./...`, the 38 targeted
desktop/frontend tests, the production frontend build, and `wails3 build` all
pass. This is a compile/build gate, not an interactive or native-media
acceptance test.
