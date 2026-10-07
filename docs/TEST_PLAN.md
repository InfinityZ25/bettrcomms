# Verification and test plan

## Test layers

For the October unified-channel/attachment batch, the web production build,
489 Vitest tests, `go test ./...` with Docker PostgreSQL integration and
`go vet ./...` passed.
Targeted Chromium community/attachment acceptance passed against the real API,
PostgreSQL and MinIO. Automated results are recorded in
[PR #40](https://github.com/InfinityZ25/bettrcomms/pull/40). Release requires the
Chromium suite and the optimized-build Chromium/WebKit matrix.

`tests/attachment-upload-flow.spec.ts` verifies local and sent PNG previews,
interrupted-upload retry without losing the draft, separate downloads with exact
original bytes, outsider denial and MP4 playback/upload/download above
the former 10 MiB limit. Its synthetic H.264 fixture has a valid ISO BMFF free box
appended to exceed 16 MiB while preserving playback. This run does not establish
the configured 500 MiB/2 GiB size boundaries or production proxy/network behavior.

Regression coverage also checks that leaving a view or replacing an account
cancels a waiting download without navigating a late response, while a completed
download remains open. Cancelled voice joins must reject late completion and
release microphone/signaling resources. Backend revoked-session upload tests
verify both immediate object/row deletion and an inaccessible, retryable tombstone
after storage failure; authorization checks remain unchanged.

The footer's transparent background now passes pointer input to underlying share
zoom controls, and fullscreen control alignment is independent of an open chat
pane. Browser regression acceptance requires normal zoom clicks with the footer
visible, usable footer buttons, and centered fullscreen controls with chat open
across the required Chromium and optimized-build Chromium/WebKit matrix.

Navigate between channels and back to an active call, then resize its stage;
camera layout observation must follow the mounted stage and ignore stale callbacks.
Delay the initial real `/rooms` response until Messages is selected, then require
the direct-message list to appear without another click. Preserve the two-second
realtime delivery checks and zero presence polling.
Remove the selected room's membership through the real API and require the
replacement conversation and sidebar selection to agree without a page reload,
both from Rooms to Messages and from Messages to Rooms.
Sign out or revoke the active session, then sign in as another account without
reloading; its initial room determines navigation instead of the previous choice.

Recording regressions cover the final data block arriving after the recorder is
already inactive, including track removal, track end and recorder errors. Audio
fixtures wait for rendered samples and verify decoded duration before storing a
declared timeline. WebKit startup must work without `AudioWorkletNode`; RNNoise
and Speex imports are deferred until their audio paths are requested.

Continue the release acceptance matrix in `COMMUNITIES.md`, including configured
size boundaries, upload cancellation and pending-file cleanup, all room role pairs,
announcement admission and active voice switching. Test source alone is not
evidence of a passing run, and synthetic browser media does not satisfy physical
device, native capture/encoding or cross-network gates.

Unit tests cover permission resolution, event sequencing, audio gain bounds, layout math, manifest/index transitions, quota eviction, and capability-state serialization. Contract tests run the React client against the Go API and signaling service with clock and disconnect control. PostgreSQL integration tests use real migrations and constraints. Browser automation covers primary keyboard and screen-reader semantics but does not substitute for real media tests.

Wails Go tests must assert that unfinished native features cannot serialize as implemented. Desktop CI runs Go vet/tests, frontend build/tests, and platform packaging checks. The web production artifact is built before the Wails host and the packaged app is launched without the Vite server.

## Required real two-peer network matrix

Use two physical endpoints and record client build, browser/WebView version, OS, network, selected devices, ICE candidate pair, codec, bitrate, packet loss, jitter, RTT, and result. Synthetic loopback tests do not satisfy this gate.

| Path | Peer A | Peer B | Expected result |
|---|---|---|---|
| LAN direct | Same wired/Wi-Fi LAN | Same LAN | Host or reflexive pair; bidirectional audio/video; no TURN allocation selected |
| Independent NATs | Residential network A | Residential/mobile network B | Direct when possible, otherwise relay; join within target |
| Forced TURN UDP | Network A with non-relay candidates filtered by test policy | Network B | Relay pair, media and reconnect succeed |
| Forced TURN TCP/TLS | UDP blocked in controlled firewall | Independent network | Relay over permitted transport; degraded state is visible |
| Direct-only success | Compatible NAT pair | Compatible NAT pair | Direct pair; UI confirms relay disabled |
| Direct-only failure | Restrictive/symmetric controlled NAT | Independent restrictive network | Bounded failure with actionable message; TURN is never selected |
| Network handoff | Wi-Fi, switch to hotspot during call | Stable independent network | ICE restart/recovery or explicit bounded failure; no phantom connected state |
| IPv6/dual-stack | IPv6-capable network | Dual-stack independent network | Valid selected pair and stable media; address data redacted from product logs |

Run voice-only and camera+screen-share variants. Each successful path includes a 30-minute soak; release candidates include at least one two-hour audio soak. Inject 1%, 3%, and 8% packet loss plus jitter and bandwidth steps in a controlled network. Verify audio remains intelligible and prioritized, video adapts, stats reflect impairment, and recovery occurs after removal.

## Media quality and DSP

Feed calibrated speech, music, silence, impulse, and background-noise fixtures through a hardware loop where possible. Measure clipping, gain convergence, pumping, echo, latency, CPU, and underruns. Per-user volume and normalization must remain local. Toggle RNNoise/standard suppression during speech and music; unsupported paths expose unavailable state. NVIDIA/Krisp tests require the real installed product/SDK and must verify clean fallback when removed.

Test negotiated Opus channels, DTX/FEC behavior where inspectable, and bitrate response; do not pass based only on requested constraints. For video, record actual codec, encoder implementation signal where available, resolution, fps, keyframes, CPU/GPU load, thermal behavior, and fallback reason on integrated, discrete, and software-only paths.

## Stage layout

Capture visual baselines at 960×640, 1280×720, 1440×900, ultrawide, 125/150/200% Windows scaling, and browser zoom. Exercise 1, 2, 4, 8, and maximum-supported camera tiles; wide/tall/shared-window content; resize drag; collapse; pin; popout; fit/fill/100%; wheel, keyboard, and touch zoom/pan; fullscreen; and device rotation where supported. Automated checks assert no overlap, inaccessible controls, negative pane sizes, or transform NaN. Manual checks cover focus order, screen-reader labels, reduced motion, contrast, and motion sickness from speaker changes.

## Native Windows capture matrix

Use supported Windows versions with Intel integrated, AMD, and NVIDIA GPUs; single/multi-monitor; mixed DPI; SDR/HDR; windowed, borderless, and exclusive fullscreen games; minimized/occluded windows; game restart; resolution change; GPU driver reset where practical; elevated/non-elevated combinations; and a protected-content sample. Record exact reason codes for unavailable cases.

For process audio, play unique watermarked tones simultaneously from target, child process, unrelated app, microphone, and system notification. The recording must contain only the explicitly selected process scope. Test default-device switch, Bluetooth profile change, silence, process respawn, sample-rate mismatch, and permission denial. A whole-system fallback is a separate opt-in test.

Native capture runs 60 minutes while checking A/V drift, memory/handle growth, queue depth, dropped frames, underruns, CPU/GPU, and thermal pressure. Forced cancellation, webview reload, process exit, device loss, and desktop app crash must release OS sessions and privacy indicators.

## Recording and viewer-local rewind

Inject distinct timestamped tones and video counters per track. Verify the manifest maps wall and monotonic clocks, gaps, restarts, mute spans, identities, codecs, hashes, and segment boundaries. Reconstructed tracks meet the chosen sync tolerance across one hour and after reconnect. Composite export is checked against independent source tracks.

Set tiny duration and byte quotas to force deterministic eviction. Verify only complete oldest segments leave, indexes update atomically, seeks clamp to available bounds, “live” returns to the current edge, and one viewer's seek changes no remote state. Test full disk, revoked permission, corrupt/truncated segment, crash during manifest replacement, OS sleep/time change, logout, and concurrent cleanup. Confirm cleanup and encryption-key behavior match the retention policy.

## Security and authorization

Run a role/resource matrix at HTTP and WebSocket layers; mutate community/channel membership mid-session and verify event delivery stops. Fuzz signaling size/rate/order. Verify short-lived TURN credentials expire and belong to the expected user. Inspect the packaged Wails service bindings and page-token checks: no arbitrary shell, unrestricted filesystem, or process execution surface. CSP and dependency advisories are release gates.

## Release evidence

Store a signed test record with commit/build ID, environment matrix, automated results, physical runs, known failures, and status for every capability. Any skipped required row keeps the feature experimental or unavailable. Native media may be described as implemented only when the tested shipping build produces real media on the declared support matrix.

## Local recordings library and mixer

Verify stopped calls automatically save, including leaving a room and automatic size-limit stop. Restart the same browser/app profile and reopen the recording. Decode real MediaRecorder blobs; test two independent audio tracks and a video, late track offsets, seeking, per-source mute/gain, and stopping playback on close. Rename and delete must survive reload; deletion removes both metadata and blobs. Verify save errors keep original downloads and never claim success. Test real microphone/camera files on each shipped WebView as a separate device acceptance check. Completed recordings are local to the profile/origin; in-progress recordings still require a clean stop and are not crash recoverable.

## Native permission recovery

The native permission flow requires packaged Wails acceptance on Windows, including explicit deny/re-enable and synthetic microphone/camera cleanup. Ordinary browsing still requires browser permissions. Check Windows privacy restrictions separately on a physical device.
