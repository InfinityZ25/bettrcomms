# Wails migration completion ledger

Target: finish the desktop migration and deliver a reviewed, tested PR. Deployment
is excluded. The latest goal includes screen sharing, superseding the earlier
audit's screen-sharing exclusion. Preserve Tauri and the shared web frontend.

Baseline: `notzair/wails-v3-migration`, initially `dc930ba`; remote main from the
audit is `691f3e5`. Revalidate the remote before integrating it.

## Existing local work

At the beginning of goal work, notifications, call alerts/sounds, settings and
call UI changes were already dirty. These belong to the user and must be
preserved. `apps/mobile` also contains unrelated dirty work and must not be
included in the desktop PR. Do not claim the goal complete from unit tests alone.

## Requirements and evidence still needed

- [x] Integrate current main: production domain, SFU client/server and connection
  mode/RTT fixes, preserving Wails API proxy authentication and current UI.
- [ ] Native frontend adapter for all implemented desktop features, without
  pretending Wails has Tauri IPC.
  - Export/save and conversion: wired; unit tests check base64 byte fidelity,
    cancellation, dialog dismissal, token authorisation and unified Go finish.
    Native dialog/real-file acceptance still required.
  - Global PTT: wired; unit tests check Wails events, session ordering, disposal
    and token authorisation. Real background key/mouse acceptance still required.
  - Media privacy settings: wired; native UI acceptance still required.
  - Camera overlay: frontend adapter connected, with bounded base64 RGBA for
    Go bindings and the existing single-frame-in-flight lifecycle. Tests cover
    byte fidelity, authorisation, size limits, frame acknowledgement/failure
    and preservation of Tauri binary IPC. Real Windows overlay acceptance and
    sustained transport performance remain required.
  - Screen picker/FFmpeg setup, capture, native WebRTC, process audio and native
    recording now use a Wails adapter. It wraps source lists, normalises SDP
    offers/answers, decodes bounded base64 PCM/MP4 chunks, supplies the MP4 MIME
    type, and routes capture-ended events. Tauri's path remains intact.
    Wails adds bounded source thumbnails (two jobs, three seconds, 512 KiB) and
    cleans up and emits an event on unexpected encoder termination.
    Full Wails-window sharing/recording acceptance remains. Copilot now has a
    Wails adapter with validated dimensions/coordinates and bounded base64 RGBA;
    interactive overlay/expiry acceptance remains outstanding.
- [ ] Authenticated, bounded worker/worklet DSP transport with independent
  sessions, cleanup, fallback and native acceptance for DeepFilterNet/NVIDIA.
  - Added `internal/native/audiostream`: loopback binary PCM websocket matching
    the existing audio Worker protocol, exact caller-supplied origin policy,
    first-message token authentication, fixed finite frames, single client,
    idle/unused-grant expiry and one OS thread per independent effect.
  - Manager limits starting/live sessions to three and handles shutdown during
    effect construction. Authorised AudioStreamStart/Stop services now create
    isolated NVIDIA/DirectML effects, enforce exact audio origins, and expose
    generated bindings used by the existing Worker/AudioWorklet frontend.
    Removed unused, unauthorised JSON-per-frame DSP service methods. Engine and
    stored-processing selection recognise Wails. Settings status/install UI now
    uses the Wails adapter; readiness maps actual GPU probe results, not file
    presence. Native probes and install actions require page authorisation.
- [ ] Optional runtime installers and their trust/verification tests.
  - DSP installers now embed the existing Tauri pinned scripts, model and
    licences. The staging script and source-equality/hash tests prevent drift.
    Private staging, reparse checks, bounded stderr, Windows job ownership and
    cancellation/timeout cleanup are implemented. UI buttons are connected.
    Fresh-install, rollback and cancellation acceptance still required; no
    existing runtime has been replaced to test this path.
- [ ] Native service security and resource lifecycle audit, including DSP entry
  points, page navigation, revoked sessions and binary transport limits.
  - Page authorisation now also protects native session continuation/teardown,
    screen-source enumeration, signaling, file reads, system audio reads and
    camera/copilot operations. Regression invokes sensitive methods against
    uninitialised managers and proves they reject before touching resources.
    Final capability-probe, navigation and resource-lifecycle review remains.
- [ ] Production API domain/version, packaged HTTP/WebSocket auth/session tests.
- [ ] Windows distributable/installer and release build automation; no deploy.
- [ ] Reconcile capability reporting and stale scaffold documentation with the
  actually connected and validated functionality.
- [ ] Final build, unit/backend suites, real API/database Playwright checks,
  native and packaged acceptance. Report hardware limitations honestly.
- [ ] Commit relevant work, push branch, create PR and attach it to the task.

## Validation during implementation

2026-09-21: fixed the custom packaged API origin discovered in the previous
audit. Both the Wails build task and PowerShell entry point now use a validated
HTTPS authority and a linker-injected default. Build configuration uses its own
environment variable and is restored on exit, separate from runtime overrides.
The offline --print-build-info path starts no window, media, credentials or
network listeners. A real compiled executable retained packaging.example:8443
with both build/runtime environment variables removed; the test restored the
normal executable afterward. Rejected origins cover HTTP, userinfo, paths,
queries/fragments, invalid ports and linker-option injection. Added this binary
acceptance to Windows CI. Go configuration regression, full Go tests and full
vet pass. Full build-desktop-wails.ps1 and actionlint passed; the restored binary
reports https://app.bettrcomms.com. Hosted workflow execution and packaged
interactive auth remain open.

2026-09-21: added a Windows Wails job to the existing PR/push validation workflow:
Go 1.26, pinned Wails CLI, full build/vet/tests, staged FFmpeg acceptance without
a private install, native-asset source parity, and a seven-day portable CI
artifact (not a published release or deployment). actionlint v1.7.7 passed.
The workflow has not yet run on GitHub; hosted-runner/hardware behaviour is not
claimed. The prior ten-test browser run finished with ten failures, including
stale settings navigation and room-heading selectors. Trace inspection proved
Recordings navigation itself passed. Updated both call-view-switching tests to
use the Settings account menu/dialog and room selection/participant-list state,
retaining mute and session persistence assertions. Both passed with real local
API/database and synthetic browser media. The remaining eight browser failures
(connection diagnostics, device settings and direct navigation) still need review.
Also found that build-desktop-wails.ps1's ApiOrigin option currently sets only
the build process environment, not a linker-embedded default; fix and test before
claiming custom-origin portable builds work.

2026-09-21: the DeepFilterNet foreign pointer return now uses typed purego
bindings, pinned at v0.11.0. Full Wails vet passes without disabling unsafeptr;
the task definition no longer disables that analyser. Actual AMD model load,
processing, reset and attenuation acceptance passed; measured processing was
3.698 ms per 512-sample frame (10.667 ms budget). This is not sustained call or
NVIDIA acceptance.

2026-09-21: connected the bundled FFmpeg directory to host startup, resolved
relative to the executable. Wails builds stage the exact pinned executable,
licence, setup metadata and source notice beside the app. Source/destination
hash checks passed. A new opt-in acceptance test ran the packaged FFmpeg 8.1
from an unrelated working directory with an empty private application-data
directory. Configuration also rejects subsequent redirection. Wails build and
frontend production build passed, as did 232 frontend tests, all Go packages
and full vet. Native enumeration required execution outside the sandbox.
The first nested Windows PowerShell build could not find Get-FileHash; explicit
loading of that shell's own Utility module fixed it and the build passed.
Updated the host README to reflect implemented adapters and outstanding gates.
This prepares a portable directory, not an installer; release CI remains open.

2026-09-21: initial PTT/export adapter passes frontend production build and all
200 unit tests (29 files). Vite requires execution outside the sandbox because
Windows blocks its native dependency processes in the sandbox. This evidence
covers the adapter contracts, not a real native user interaction.

2026-09-21: privacy-settings and camera-overlay adapters bring the full frontend
suite to 209 passing tests (31 files). Production build passes. Remote main was
fetched again and remains at 691f3e5; it has not yet been integrated. Camera
frame transfer uses generated JSON/base64 bindings, not zero-copy binary IPC;
native load/latency acceptance must establish whether this meets the budget.
The targeted Playwright camera-overlay test also passes in Chromium: synthetic
camera compositing produces the expected RGBA pixels and disposal preserves
the original media track. This does not exercise the native overlay window.

2026-09-21: audio transport/manager tests pass using real loopback WebSockets,
including malformed frames, rejected auth/origins, independent sessions, expiry,
slot limits and startup/shutdown races. Targeted `go vet` passes. Full Wails
`go test ./...` passes; full `go vet ./...` fails on the existing foreign-return
pointer conversion at `internal/native/deepfilter/ort_windows.go:130`. This
needs a reviewed FFI solution, not disabling the analyser. No GPU acceptance
claim is implied by tests using a synthetic processor.

2026-09-21: connected DSP service/Worker adapter passes 213 frontend tests and
production build; Wails Go suite passes. A fresh Windows acceptance test drove
30 actual 512-sample binary frames through AudioStreamStart and installed
DirectML on AMD Radeon(TM) Graphics, checked finite, changed output, and passed.
The standalone DirectML model acceptance also passed. NVIDIA acceptance was
explicitly skipped: no supported NVIDIA GPU/package here. Renderer-stall,
audible quality, sustained load, simultaneous microphone/call effects and
fallback acceptance remain outstanding. The full-vet foreign-pointer issue
noted above remains unresolved; no analyser has been disabled.

2026-09-21: DSP settings and installers pass all 215 frontend tests and production
build, all Wails Go tests, and targeted vet for dspsetup/audiostream. Tests cover
embedded parity with Tauri assets, the model's pinned hash, required notices,
cancelled/unknown install requests, and page authorisation before downloads or
GPU probes. No installer download was performed. NVIDIA's capability cache is
invalidated after successful setup so the settings refresh does not retain an
old unavailable result. Full vet still needs the foreign-pointer fix.

2026-09-21: native capture adapter passes 221 frontend tests (33 files), frontend
production build and the Wails Go suite. Adapter tests cover SDP, collection
shapes, call-audio exclusion defaults, bounded recording reads, MIME, thumbnail
authorisation and ended events. A real Windows monitor thumbnail test decoded a
640x360 JPEG in 0.40 seconds; the image remained in memory and was not displayed
or persisted. This verifies thumbnail capture only, not end-to-end calls.

2026-09-21: copilot and expanded per-call native authorisation pass 224 frontend
tests (34 files), production build and all Wails Go tests. Tauri's existing
copilot availability test now waits for lazy bridge imports rather than assuming
a fixed number of microtasks. No assertions were removed. Native security tests
cover denied start, continuation, read, clear, stop, install and GPU-probe calls.

2026-09-21: saved migration checkpoint 2c53e77 (including pre-existing related
desktop/frontend UI and notification work; mobile excluded), then integrated
origin/main 691f3e5. Kept the refactored UI structure, ported the unified
connection mode and isolated RTT subscription to it, preserved desktop browser
auth endpoints, and incorporated main's SFU endpoint/transport and regressions.
SFU join uses the desktop proxy's bearer header and omits browser cookies there;
browser requests retain same-origin authentication. Main still does not select
SFU as the default call path; this merge does not claim otherwise. Wails trusts
app.bettrcomms.com consistently with Tauri. Validation: 232 frontend tests,
production build, Wails desktop-policy tests, server tests with local Docker
TEST_DATABASE_URL, and server go vet passed. Integrated E2E remains pending.
