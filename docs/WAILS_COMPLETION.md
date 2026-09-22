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

Window controls now use the built-in `@wailsio/runtime` Window API rather than
an application-defined Go `WindowService`; its registration and generated
bindings were removed. Native non-client regions remain enabled. Frontend tests
(232), the production frontend build, and Wails Go tests/vet passed. This is
not native UI acceptance: a rebuilt production host still displayed the window
action failure. It was closed without a session or call. A subsequent diagnostic
launch was interrupted by the user through Escape; desktop automation stopped.
The isolated packaged-runtime Playwright diagnostic initially failed before
the first built-in window request; the chunk-cycle fix below now makes it pass.
Native revalidation remains open. See WAILS_PR_HANDOFF.md for PR blockers.

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

2026-09-21 follow-up: reproduced the compiled JS runtime import failure as
`TypeError: Cannot read properties of undefined (reading 'Call')`. Automatic
chunking put runtime.js and calls.js into mutually importing chunks, evaluating
the caller before objectNames initialisation. A targeted Wails runtime chunk
group fixes this without changing the native APIs or relaxing CSP. The real
production JS runtime now passes an isolated browser test of state, maximise,
minimise and close with host HTTP replies simulated. The fixture explicitly
returns JSON boolean/null content types. The regression is no longer opt-in.
This is not acceptance of real Windows caption input or Snap Layouts; native
revalidation remains open after the user's desktop automation interruption.

2026-09-21: rebuilt the production executable with the current staged frontend
and inspected its real Windows window using Computer Use. The React home/sign-in
screen rendered at `http://wails.localhost/` under CSP, but clicking the HTML
Maximize control displayed "Window action failed. Please try again." No window
maximisation was observed. This is a confirmed native acceptance failure, not a
passing runtime smoke. Generated method ID 3549911582 matches the pinned host's
FNV hash of `main.WindowService.ToggleMaximise`; a simple binding-ID mismatch is
not the cause. Production F12 did not expose devtools, as expected. Built a
separate ignored `bin/bettercomms-wails-diagnostic.exe` without production tags
for subsequent diagnosis, but did not launch it. Computer Use refused two close
attempts due to detected user input (with a fresh observation between attempts),
so no more input was sent. The production test window may remain open. No sign-in,
device permission, camera or microphone action was performed. CSP versus runtime
transport/root cause remains unproven and must be resolved before acceptance.

2026-09-21: added document CSP to the Wails asset handler. Packaged documents
allow self/blob scripts, WASM compilation and only the exact boot script's
SHA-256 inline hash; block objects, frames, embedding, base-URL changes and form
submissions; keep local API/DSP transports, local workers, blob recordings and
HTTPS images. Development retains Vite's refresh preamble while enforcing the
document restrictions. Boot is read once for both document and policy; tests
hash the actual served inline script, check policy changes with its contents,
and verify no-store/no-referrer/nosniff. Injection/policy errors now fail closed
with a generic 500 rather than serving an unconfigured document. Full Wails Go
tests and vet pass. Actual Wails runtime and
media acceptance under CSP remains pending, as does top-level navigation control:
the pinned Windows host sends external requests directly through WebView2, not
the app asset handler, so this CSP must not be described as a navigation firewall.

2026-09-21: audited the pinned Wails Windows permission/navigation code. Its
public navigation callback does not expose a cancellable URL policy, so external
browser sign-in cannot justify blanket media grants. Removed PermissionAllow
for microphone/camera in favour of explicit PermissionDefault, retaining the
nonempty deny policy for geolocation/web notifications/clipboard read (an empty
policy triggers upstream's blanket allow fallback). Added a host-policy regression
test and corrected capability reports and documentation. PageGate documentation
now explicitly distinguishes a process-lifetime bearer token from a navigation
allowlist/current-origin check. Full Wails Go tests and vet pass; all 232 frontend
tests and production build pass. Native prompt acceptance, stored-grant revocation,
navigation restriction and document-token lifecycle remain open; this change
does not claim complete security parity. Existing installer artifacts predate it
and must be rebuilt before final packaged acceptance.

2026-09-21: rebuilt installer (91,462,225 bytes) passed the expanded native
acceptance script with exit 0. Real Windows sharing locks on both the installed
host and FFmpeg caused upgrade and uninstall to return 67 before changes;
subsequent SHA-256 checks and build-info execution proved all payloads remained
intact, with shortcut, registration and uninstaller preserved. Same-version
reinstall without /D reused the registered custom directory. Normal uninstall
then removed all owned files and registration while retaining the sentinel.
This verifies locked-file refusal, not a running interactive call or transactional
rollback after disk failure or a process starting after preflight. Those cases,
WebView2 prerequisite provisioning, version-changing upgrades and actual CI run
remain open. No Tauri or real user profiles were modified.

2026-09-21: installer preflight now checks all existing payload files before
copying or deleting anything, including FFmpeg which can still be in use after
the host window closes. Added OS file-sharing-lock acceptance for the host and
FFmpeg: both upgrade and uninstall must refuse with exit 67, preserve hashes,
registration, shortcut and recovery uninstaller. Reinstallation now omits /D
to check that the registered custom install directory is reused. Compilation
and these new native acceptance cases are in progress; no pass is claimed yet.
Windows CI now provisions NSIS 3.11, packages after the validated portable build,
runs installer lifecycle acceptance, and keeps a separate installer artifact
without publishing a release. Actionlint 1.7.7, PowerShell parsing and diff checks
pass; the updated workflow itself has not yet run on GitHub.

2026-09-21: the actual compiled NSIS installer passed isolated Windows acceptance
through `scripts/test-wails-installer.ps1` (exit 0). Fresh per-user installation,
same-version reinstall, every payload's SHA-256 equality, installed build-info
execution, shortcut/registration creation and removal, and deletion of all known
installed files (including the uninstaller) passed. An unknown sentinel file was
preserved unchanged. The unique `.local/wails-installer-test-*` fixture directory
is retained for inspection; no Tauri install/profile was touched. This does not
prove version-changing upgrades, running-app safety, partial-failure rollback,
prerequisite installation or fresh frontend/native acceptance. Those gates and
installer CI remain open. The three browser repetitions after compilation ended
with two passes and one Watch-button timeout; full E2E is still not green.

2026-09-21: NSIS 3.11 from the existing Tauri compiler cache successfully
produced the Wails installer (91,454,753 bytes, exit 0). This validates package
compilation, not installed operation, and used the existing portable binary;
the final distributable still requires a fresh complete build. Added an opt-in
real installer acceptance script: refuses existing Wails registration/shortcut,
uses a unique workspace-local destination, compares all payload hashes, probes
the installed executable, reinstalls the same version, then uninstalls and
checks registration/shortcut/package removal while preserving an unknown file.
Script parsing passes; execution is pending until the sequential browser run
finishes. No real user installation has been changed.

The failing repetition's trace showed a hover taking over six seconds against
a 3.6-second idle timer. After NSIS exited, another three-repetition browser run
was started; its first case timed out at Watch (not the idle footer), so compiler
contention alone does not explain the instability. This run remains in progress.

2026-09-21: revalidated GitHub main with `git ls-remote`: still 691f3e5,
already an ancestor of this branch. The next full Playwright run finished with
90 passed, one optional TURN skip, and one integral-call failure: idle controls
intercepted Stop recording after the pointer returned to its previous coordinate.
The helper now moves between distinct coordinates and checks controls-visible,
without force clicks. Three sequential repetitions gave two passes and one
Fullscreen-call timeout when controls hid again. This remains unresolved; do not
claim a green full suite. NSIS compression overlapped the repetitions, so rerun
without that load before attributing the remaining timeout to the product.

2026-09-21: added a Wails-only per-user NSIS installer and packaging entry points.
The package includes the executable and verified FFmpeg/notices, uses separate
Tauri-independent registration/shortcut/path, and removes only exact owned files
on uninstall. Missing WebView2 stops installation before copying files; automatic
prerequisite installation is not yet implemented. Package script checks binary
and package versions and supports an explicit NSIS path. Compilation is in
progress using the existing Tauri NSIS 3.11 cache; native install, upgrade,
uninstall, running-process/partial-failure handling and installer CI remain gates.
The SourceForge download returned HTML and failed the pinned checksum, so none
of that downloaded content was executed. PowerShell parsing and git diff checks
passed. No user installation or profile was modified by these checks.

2026-09-21: the remaining three full-suite failures pass in targeted runs.
Realtime events now hydrate/send chat in a direct conversation, then select
the channel to check call/mute presence; history-read and zero-presence-poll
assertions plus online/offline propagation remain. Recording playback needed
only exact navigation-button matching; hash equality, WAV conversion, per-source
mixing, timeline, fullscreen node/state preservation and persisted deletion all
pass (10.1 seconds). Signaling-resume uses the current second-device action and
connection diagnostic, and now also proves the remote camera retains its live
track ID and decodes additional frames after recovery (15.8 seconds). The drop
is simulated at the signaling callback, not an actual deployed-server restart.
All eight failures from the prior full run have targeted passing evidence;
a fresh complete suite is still required before claiming global regression pass.

2026-09-21: five of the eight full-suite failures now pass in targeted runs:
call layout, presence UI, multi-device call and both native-caption fixtures.
Updated layout menus, active-room accessible name (includes live count), lobby
regions/text and second-device actions without removing session/count checks.
Camera geometry checks preserve 16:9 and require over 90% of the maximum size
that fits the current canvas; the prior height-only requirement exceeded the
width-constrained aspect fit. Focused navigation checks inert/aria-hidden and
the animated wrapper's zero width, rather than the unclipped child's bounds.
Layout still checks drag/resize limits, unchanged share track, zoom/pan,
fullscreen overflow, mobile bounds and decoder continuity while frozen.
Caption fixtures use controlled CSS colours and verify one titlebar, updates
and observer cleanup independently of renamed branding/current theme shades.
Final layout case passed in 18.1 seconds. Realtime-events, recordings and
signaling-resume remain unresolved; full suite must be rerun after those fixes.

2026-09-21: complete 92-case browser run finished in 11.4 minutes: 83 passed,
eight failed, one optional TURN case skipped. Failures are call-layout,
call-presence-ui, multi-device-call, both native-window-controls fixtures,
realtime-events, recordings and signaling-resume. Initial failures reference
retired room selectors/menu controls, lobby wording, second-device actions,
fixed prior-theme colours/title text, channel-chat navigation and an ambiguous
Recordings button. These initial observations do not prove that deeper checks
pass. Adjustments for the first five cases are under targeted validation;
realtime events, recording playback and signaling resume still need adaptation.
No tests were disabled to obtain this result. The earlier complete-suite result
was pending; this entry records its actual terminal outcome.

2026-09-21: the integral bettercomms browser case passes in 40.5 seconds.
Updated it to send persistent chat through a direct conversation, explicitly
select the channel under Calls, use current diagnostics/settings controls,
return through the live-call dock and export from the persisted recording
library. Real pointer movement reveals auto-hidden call controls; no forced
clicks. Fullscreen equal-size cameras remain checked with a four-pixel centre
tolerance, measured within media space after the deliberate recording-indicator
inset. Preserved diagnostic secret exclusion, two-camera decode, two simultaneous
synthetic shares, independent complete/nonempty microphone/camera/screen/system
manifest entries, and remote track removal on stop/leave. Dev-auth retry respects
the existing limiter. The complete 92-case browser suite has now been launched
sequentially; its result is still pending. This is not native Wails acceptance.

2026-09-21: visual-copilot tests now use the Settings dialog, current switches
and custom selectors, and explicitly close the dialog before selecting Calls.
The first two-client run exposed a real regression: the transport received the
mark and its acknowledgement, but the viewer rendered only the interaction hint,
discarding the transport status. Restored that status after disabled/disconnected/
missing-permission checks so delivery, rejection and timeout feedback is visible.
Both Playwright cases now pass (41.6 seconds): opt-in/preferences/PTT conflicts,
point acknowledgement/expiry, laser movement, frozen-frame fidelity while live
video changes, marked-capture delivery, unchanged source track, pause revocation
and fresh-share permissions. Inspected synthetic mobile-settings and received-
capture screenshots. All 232 frontend unit tests and production build pass.
This verifies browser collaboration, not interactive native Wails overlays.

2026-09-21: both received-audio PTT cases now pass against the real local API
with two Chromium clients and a synthetic tone, for automatic and explicit
server voice routes. They keep a channel call running while typing in the
current direct-conversation UI, then return through the call dock. Explicitly
select Calls before the channel: creating a conversation otherwise opens the
Messages section. The initial run timed out waiting for that absent channel
button, before starting media; the second case was interrupted to fix the same
navigation issue. Preserve bc-voice-route for server voice; bc-connection-mode
is a separate ICE/TURN policy and remains automatic in these cases. Received
RMS, mute presence, focus release, shortcut changes, source continuity, pending
replacement and rejoin assertions remain. These are browser transport checks,
not physical background PTT or packaged Wails acceptance. Final complete PTT
file: all six cases passed in 1.1 minutes, including updated checks against the
actual destructive mute-button style instead of the removed danger class.

2026-09-21: updated push-to-talk settings navigation, switch roles and modal
dismissal; the side-mouse target now selects the visible level-two heading
rather than an ambiguous accessible label. Four targeted PTT browser cases
pass (typing preference, side buttons/history, shortcut persistence and pending
sender replacement). Updated speaking-sensitivity navigation and added explicit
getUserMedia request counters before/after reload: both speaking-activity cases
pass, including meter hysteresis/cleanup and persistence without opening a
device. All 232 frontend unit tests and production build pass. The two received
audio PTT cases are still pending: their retired channel-chat controls need
adaptation to the current conversation UI. Neither case was deleted or marked
skipped. These browser checks do not establish native background-hook acceptance.

2026-09-21: updated camera-quality, loopback, processing and DirectML browser
specs for the Settings dialog and accessible custom selectors. Added a shared
navigation helper that works on desktop/mobile without reloading active media.
Thirteen tests passed across the targeted runs: camera constraint fidelity,
unsupported-mode gating and stopped old tracks; five monitor/loopback cases
(including measured one-second delay, no recorder, sustained signal and late
track cleanup); five processing cases (RNNoise output, gate, persistence and
browser fallback); two DirectML preference/readiness cases. The native-readiness
UI case uses a simulated Tauri backend, not real Wails GPU/install acceptance.
Assertions on capture parameters, sound samples, output routing and cleanup
remain intact. These changes affect tests only. Full E2E and native acceptance
remain open; other retired-settings references still need review.

2026-09-21: the expanded 92-test browser run exposed stale accessibility-screen
navigation; it was intentionally stopped before completion to investigate.
Updated the public sign-in and utility-screen checks for the current controls
without disabling Axe rules. Found and fixed real accessibility regressions:
an invisible, redundant category tooltip swallowed the first Escape in Settings;
slider labels were on the container rather than the nested range input; the
mobile empty-recording instruction lacked sufficient contrast. One Escape now
closes Settings and restores account-button focus. Ten accessibility/device/call
navigation tests passed; Axe reports no tested A/AA violations at desktop,
compact and mobile sizes. All 232 unit tests passed. Inspected the generated
mobile Recordings screenshot. The complete 92-test suite is not yet green;
eight other spec files still reference retired settings navigation and need
case-by-case review, not blind replacement or deleted assertions.

2026-09-21: all five remaining failures from the initial targeted browser run
are resolved. Direct navigation now exercises the actual Messages section and
one-click conversation Call action; two real API clients verify friend labels,
remote call presence, mute propagation and removal after leave (one test passed).
Device tests now exercise the Settings dialog/Voice & devices page rather than
the retired hash screen/native selects. They preserve no-capture-on-open,
five-second microphone playback, camera frames, denied permissions, late-track
cleanup, live output routing, devicechange refresh and mobile overflow checks.
All four passed. Added an accessible name to the mobile settings-category picker.
232 unit tests passed. This resolves that targeted set, not the full E2E suite
or native Wails acceptance; a broader browser run is the next gate.

2026-09-21: resolved the three connection-status browser failures. Tests now
observe the actual icon-only control's tooltip/accessibility description and
wait for the signaling event subscription, not removed button text. Fixed real
regressions as well: TURN calls no longer claim a direct route, relayed voice
explicitly labels signaling ping as distinct from end-to-end audio latency,
and video no longer claims it is always direct. Socket replacement clears old
RTT and unsubscribes; negative/non-finite measurements become unknown while
zero remains valid. Four Playwright checks (including the new socket/invalid-RTT
regression), all 232 frontend unit tests and the production frontend build pass.
Five of the original ten E2E failures remain: four device-settings cases and
one direct-navigation case. Full integrated/native acceptance is still open.

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
