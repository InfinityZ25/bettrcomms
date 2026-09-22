# Tauri 2 to Wails v3 migration

Status: initial architecture, September 2026. This describes what exists in the
repository now. It is not a claim that the Wails host replaces the Tauri host.

## Shape of the migration

`apps/desktop-wails` is a Wails v3 host over the same frontend. The native media
stack is being rewritten in Go under `internal/native`, module by module, each
with an acceptance test that runs on this host. Nothing is shared with the Rust
host and nothing bridges to it: a module is either ported and tested here, or it
is reported unavailable and the frontend takes its browser path.

### Ported so far

| Module | Go package | Acceptance evidence |
| --- | --- | --- |
| `gpu_devices.rs` | `native/gpudevices` | Enumerates real DXGI adapters on the running machine |
| `native_process.rs` | `native/nativeprocess` | A real child is confirmed inside the app's job object |
| `ffmpeg_setup.rs` | `native/ffmpegsetup` | Rewritten in Go with no PowerShell: download, pinned SHA-256, zip extraction, capability probe, atomic swap |
| `push_to_talk.rs` | `native/pushtotalk` | Installs real keyboard and mouse hooks; lease expiry and untrusted-window shutdown both exercised |
| H.264 level arithmetic | `native/h264` | Annex A limits and the SDP `profile-level-id` the encoder is configured against |
| `native_screen_rtc.rs` | `native/nativertc` | A real pion receiver negotiates with this sender and receives H.264 RTP |
| `native_screen.rs` | `native/nativescreen` | Captures a real display through `gfxcapture` into a real hardware encoder and produces H.264 access units |
| `native_screen_recording.rs` | `native/nativerecording` | Records a real capture to a real MP4, verified faststart with an `avc1` track |
| `recording_export.rs` | `native/recordingexport` | Streams to a chosen file atomically; conversion arguments pin protocol, format and output |
| `native_system_audio.rs` | `native/systemaudio` | Real WASAPI process-loopback activation through a hand-built COM completion handler, capturing real system audio |
| `camera_overlay.rs` | `native/overlay` | Creates a real layered window and verifies it carries `WDA_EXCLUDEFROMCAPTURE` |
| `copilot_overlay.rs` | `native/overlay` (`copilot.go`) | Real signal windows placed at the mapped desktop coordinate, excluded from capture, hidden while the share is behind another window, closed when nothing refreshes them |
| `nvidia_audio.rs`, `nvidia_setup.rs` | `native/nvidiaaudio` | Manifest and path trust, lifecycle, Ada-only hardware match, DXGI adapter detection. The SDK itself has **never run**: no NVIDIA GPU here. The hardware acceptance test exists and skips with the reason |
| `deepfilter_runtime.rs`, `deepfilter_audio.rs` | `native/deepfilter` | Loads the real model onto this machine's adapter through DirectML and denoises real frames inside its real-time budget |
| origin policy from `media_permissions.rs` | `desktop.TrustedAppOrigin`, `desktop.PageGate` | The trusted set and everything it rejects, plus the per-launch page token that replaces the per-call origin check |
| hosted WorkOS sign-in | `desktop.BrowserSignIn` + `server/internal/api/desktopauth.go` | A real sign-in completed against a live WorkOS deployment. Replay, wrong verifier, expiry, and the unconfirmed case all refused |
| session storage | `desktop.SessionStore` | Real Windows Credential Manager round trip: written by one launch, read by the next, erased on sign-out |

### Not ported

- **WebView2 Profile4 permission IPC** (`media_permissions.rs`). Wails keeps its
  WebView2 controller private and the package wrapping it is internal to Wails,
  so there is no way to reach `SetPermissionState` from Go here. This host
  instead defers to WebView2's normal microphone/camera permission decision,
  including a prompt when needed. It no longer sets blanket allow. Stored
  grants cannot be inspected or revoked by this host at runtime. See
  "Microphone and camera permission" below.
- **The NVIDIA package installer.** `nvidia_setup.rs` shells out to
  `scripts/install-nvidia-audio.ps1` for a ~700 MB NVIDIA redistributable. The
  Go side ports the parts that decide anything — Ada-only hardware detection
  through DXGI, install-readiness, and the install root — but not the download
  itself. `nvidiaaudio.InstallRoot()` is where a package must be unpacked.

Both are reported honestly in the capability report rather than as working.

Three decisions shape the host itself.

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
with a reason and, when unavailable, the fallback in use.

`capabilities_test.go` is the honesty guard. It fails if an unported capability
is promoted, and it fails if a ported one stops claiming what its acceptance
test proves. A passing Tauri test is not evidence for this host: the two share
no media code.

On Windows this host reports `nativeGameVideo`, `nativeProcessAudio`,
`nativeMicrophoneDsp`, `localTrackRecording` and `globalInput` as implemented,
each backed by a test that exercises it here. `nativeOverlays` is
`experimental`: the camera tile is real and tested, but the copilot surface is
not ported and no person has watched the tile during a call. `mediaPermissions`
remains `unavailable` with its browser fallback named.

The NVIDIA adapter is the case worth being explicit about. It is written, and
its manifest and path handling are tested, but it has never denoised a frame:
this workspace has an AMD GPU and no SDK installed. It is therefore reported
unavailable, not experimental. Code existing is not evidence that it runs.

The connection diagnostic report now carries the runtime summary, so a report
from the Wails host cannot be read as if it came from the Tauri host's native
paths. The summary carries states and platform strings only, with no
identifiers.

## The packaged API transport

A packaged host serves the page from its own origin. That origin has no API, and
two things follow that a relative `/api` URL cannot survive:

- The upstream session cookie is `SameSite=Lax`, so it is not sent on cross-site
  subresource requests. Calling the hosted API directly from the page would be
  unauthenticated.
- The realtime WebSockets cannot traverse the webview's asset scheme at all.
  There is no upgrade path through a custom scheme handler.

So the host runs a loopback proxy, `internal/desktop/apiproxy.go`, and publishes
its address as `apiBase` in the boot report. `apps/web/src/desktop/apiTransport.ts`
is the single place the frontend resolves API and socket URLs against it; a
browser tab and a development build get their unchanged same-origin path from
the same helpers.

Three properties are deliberate.

**The session never enters the webview.** The cookie jar lives in the host
process, and `Set-Cookie` is stripped from every response the page sees. Page
script cannot read, copy, or leak session material it was never given.

**Every request carries a per-launch secret.** A loopback listener is reachable
by any process on the machine, so the secret — not the `Origin` header — is what
authorises a caller. It is 32 random bytes, regenerated each launch, presented
as a bearer token; WebSockets carry it in the query string because page script
cannot set headers on a handshake. The proxy strips it before forwarding.

**Upstream's own checks are unchanged.** The proxy presents the upstream origin
on the hop it makes, which is what the API's same-origin write check and its
WebSocket `OriginPatterns` are for. That check is not weakened: it is preceded by
a secret no other site can obtain.

The frontend re-validates both halves on read, as it already does for
`apiOrigin`, and for the opposite reason: `apiBase` must be **loopback**, because
a non-loopback value there would send every request and its session off the
machine. A report carrying only one half, a short or delimiter-bearing token, or
a base with a path is discarded whole.

Covered by `apiproxy_test.go` (10 tests) and `apiTransport.test.ts` (11 tests).
Neither is an interactive acceptance pass: no packaged build has been signed in
through this path in this workspace.

## Security boundary

Carried over from the Tauri host, and tested:

- The API origin must be HTTPS, or loopback HTTP in a development build, with no
  credentials, path, query, or fragment. `ReleaseOrigin` is byte-identical to
  the Rust host's `RELEASE_ORIGIN`.
- Native entry points require the per-launch page token only a document this
  host served can hold. It is what stands in for the Tauri host's per-call
  origin check, which Wails makes impossible; see "Microphone and camera
  permission" below. Follow-on calls are gated by the opaque session, asset, or
  overlay id the entry point issued, so the page never names a window handle, a
  process id, or a filesystem path.
- Window controls use Wails' built-in `Window` runtime API and native Windows
  non-client regions, with no application-defined Go window service or better-gui.
  The auth service is three: begin, poll, cancel — it never hands
  the page a pairing, a verifier, or a session. The API proxy is not a Wails
  service; it is a loopback listener gated by a separate per-launch secret.
- Camera and microphone use WebView2's normal permission decision, not blanket
  allow. The current host does not enforce a complete navigation allowlist;
  external sign-in is not such a boundary. Geolocation, web notifications and
  clipboard read are denied. `OpenExternal` accepts three schemes.
- The webview never navigates to the identity provider: sign-in runs in the
  system browser and returns as a session in this process. See below.
- The boot report is injected as a JSON string parsed by `JSON.parse`, with
  `<`, `>`, and `&` escaped, so no value in it can close the script element.

## Signing in without leaving the window's origin

The webview must never navigate to the identity provider. It is the same webview
that holds native capture, screen sharing, recording and global input, and this
host cannot read the URL it ends up on, so a native call afterwards could not be
checked against it. Running the flow in the system browser — which is also what
RFC 8252 says for native apps — removes the question instead of answering it.

The browser and this process do not share a cookie jar, so a pairing carries the
result across:

1. The host generates a secret verifier, sends only its SHA-256 to
   `POST /api/v1/auth/desktop/start`, and gets back a pairing id and a short
   confirmation code.
2. It opens the system browser on `/api/v1/auth/desktop/confirm?pairing=…` and
   displays the same code in the window.
3. The browser page shows the code **before** anything reaches WorkOS. Approving
   it is what sends the browser on to the provider. Without this step, a link to
   someone else's pairing would sign whoever follows it into that other person's
   application.
4. The callback records the user against the pairing. It sets no session cookie
   in that browser and redirects to a "you can close this tab" page.
5. The host claims the pairing with its verifier and receives a session cookie —
   in the API proxy's jar, in this process, never in the webview. The pairing is
   destroyed by that first claim.

The pairing id is the only part that travels through the browser, and it is
deliberately not enough on its own: a claim without the verifier is refused, so
an id from browser history or a shoulder-surfed URL buys nothing.

The host builds the confirmation address from the origin it already validated,
not from an absolute URL the API returned. A client that opens whatever URL a
server hands it has given that server a way to open any page at all.

The session is then kept in **Windows Credential Manager**, encrypted under the
signed-in Windows account, so closing the application does not sign the person
out. Only the session cookie goes in: the launch token and the page token are
per-launch secrets that mean nothing in the next process, and the sign-in
verifier lives for seconds. Signing out arrives as an expiring `Set-Cookie` like
any other and erases the stored copy on the same path, so there is no separate
sign-out route that could be forgotten.

A file beside the application would have given none of that — anything running
as this person could read it, and so could anything that later copied the
directory. Off Windows there is no store and none is faked; the boot report says
which it is, because "you will have to sign in again next time" is something to
be told rather than discovered.

## The page sends no cookies to the proxy

`api()` must ask for `credentials: 'omit'` on the loopback transport, and this is
not a detail. The page has no cookies for the proxy's origin — the session is in
the host process, which is the entire reason the proxy exists — and a
credentialed cross-origin request obliges the server to answer
`Access-Control-Allow-Credentials: true`. The proxy deliberately does not,
because it accepts none, so the browser refuses such a request *before sending
it*: every call fails with a bare "Failed to fetch", the application cannot
reach its API at all, and nothing in the host's logs shows a thing, because
nothing ever arrived.

Both halves are pinned: `apiTransport.test.ts` fixes what the page sends, and
`TestProxyAdvertisesNoCredentialSupport` fixes the header's absence, so adding
it later to "fix" a credentialed request cannot pass unnoticed.

## Microphone and camera permission

The Tauri host writes a per-origin allow through WebView2's Profile4 IPC and
re-checks the page's origin on every native call. Neither is reachable from Go.
This host does not yet provide equivalent grant management or navigation policy.

**Native permission decision.** The window explicitly uses `PermissionDefault`
for microphone and camera. WebView2 applies its normal decision and prompts when
needed instead of granting all documents access. The map remains nonempty to
avoid the pinned Windows host's blanket-allow fallback. Persisted grants can
already exist; the capability report describes policy, not observed permission
status. This host cannot inspect or revoke a stored grant at runtime.

**The origin check, as a capability.** `desktop.PageGate` mints a per-launch
token, the asset handler injects it into every document it serves, and native
entry points require it. Ordinary navigation loses that document's in-memory
state, but the token itself remains valid for the process lifetime. This is not
a navigation allowlist or per-document revocation, and possession of a copied
token is not proof of the current URL. Those security gates remain open.

The token is deliberately separate from the API proxy's launch token. That one
travels on every API request; a leak of one must not grant the other.

Windows privacy settings can also refuse a device, and
`MediaPermissionOpenSettings` opens them. The scheme
allowlist there is three entries wide — `https`, `http`, `ms-settings` — because
the shell will otherwise run whatever a scheme is registered to.

## Testing NVIDIA Audio Effects

No machine in this workspace has an NVIDIA GPU, so the SDK adapter has never
processed a frame. It is written, and the acceptance test that would prove it is
in `internal/native/nvidiaaudio/hardware_windows_test.go`. On a machine with an
Ada card:

1. Unpack the pinned package (`NVIDIA Audio Effects SDK 1.6.1.2 Ada`) into the
   directory `nvidiaaudio.InstallRoot()` names —
   `%LOCALAPPDATA%\Bettercomms\nvidia-audio-effects` — with `setup.json`,
   `runtime/NVAudioEffects.dll` and the model beside it. The Tauri host's
   `scripts/install-nvidia-audio.ps1` still does the download.
2. Run `go test ./internal/native/nvidiaaudio/ -v`.

The tests skip with the reason when either half is missing, so a machine that
was never going to run them does not report a failure. They cover: the model
loading on the real GPU, output that differs from the input, the real-time
budget per frame, intensity changing the mix, voice activity detection loading,
and a stop/start round trip.

Until one of those has been seen to pass, `nativeMicrophoneDsp` must keep saying
that NVIDIA is unproven here. `NvidiaInstallInfo` reports whether the card is one
the pinned package runs on, so a settings screen can decline to offer a
several-hundred-megabyte download that would not work.

## Remaining gaps

Ordered roughly by what blocks the most.

1. **The frontend still calls Tauri IPC for native media.** Thirty-six modules
   under `apps/web/src` import `@tauri-apps/api/core` directly. The Wails host
   binds the whole native surface and the bindings are generated, but nothing in
   the frontend consumes them yet, so none of the ported media features are
   reachable from the Wails window. This is one uniform piece of work across all
   the media adapters, not a per-feature gap.
2. **The NVIDIA denoiser has never run.** Written, with a hardware acceptance
   test that skips here. See "Testing NVIDIA Audio Effects" above.
3. **No packaging, icons, signing, or installer.** `wails3 build` produces an
   unbranded executable. No macOS or Linux behaviour has been exercised.
4. **No end-to-end run of the packaged build.** A real sign-in has completed
   against a live WorkOS deployment in a development build, and the window
   opens, loads the frontend and answers bindings. A packaged build has not been
   through any of it.
5. **Composition hosting needs physical-pointer acceptance.** Its compile and
   DOM contracts are covered, but hover, press/leave routing, Snap Layouts,
   focus, DPI changes, resizing, and media rendering still require an
   interactive Windows/WebView2 pass.

## Validation

Validated on Windows with Wails v3.0.0-beta.18: `go build ./...`, `go vet ./...`,
`go test ./...`, the server's own `go test ./...`, generated bindings (three
services, 56 methods), the frontend typecheck and unit tests, and the production
frontend build.

`go vet` runs in two passes, which the Taskfile does: the full analyzer set
everywhere, then the set without `unsafeptr` on `internal/native/deepfilter`.
That package has exactly one uintptr-to-pointer conversion, in a documented
helper, because dereferencing memory a foreign library returned cannot be done
in Go any other way.

The native ports above are exercised against the real machine, not mocked: DXGI
enumeration, job-object assignment, Windows Graphics Capture, the hardware H.264
encoder, MP4 remuxing, WASAPI process loopback, DirectML inference on this
machine's GPU, a layered overlay window, global input hooks, and a real WebRTC
negotiation all run under `go test`.

The sign-in hand-off is covered on both sides: the server's `desktopauth_test.go`
drives the whole pairing, including the browser getting no session and every way
a claim can be refused, and the host's `browsersignin_test.go` drives the waiting
half against a fake API.

A real sign-in has been completed against a live WorkOS deployment: the browser
signed in, the host claimed the session, and the host logged it. Windows
Credential Manager is exercised against the real `CredWriteW`/`CredReadW`/
`CredDeleteW`, and every entry those tests make is removed again, so a test run
leaves nothing in the credential manager of whoever ran it.

What remains untested is the rest of the interactive surface: a packaged build
signing in, the API proxy carrying a real WebSocket to the hosted API, a WebView2
window completing its native microphone permission decision, and a person watching a capture in
the window.
