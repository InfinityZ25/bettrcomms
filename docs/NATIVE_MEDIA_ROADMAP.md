# Native media status and roadmap

## Current status

| Capability | Windows | macOS | Linux |
|---|---|---|---|
| Tauri 2 host loading web client | MSVC check/tests and release executable build verified; runtime smoke pending | Unverified | Unverified |
| Browser camera/microphone/display capture | Implemented by web runtime when WebView supports it; probe at runtime | Same contract, unverified | Same contract, unverified |
| Rust capability report | Implemented | Implemented, reports native features unavailable | Implemented, reports native features unavailable |
| Native game-only video | Experimental design only; no source enumeration or frames | Unavailable | Unavailable |
| Native selected-process audio | Experimental design only; no loopback session | Unavailable | Unavailable |
| Native per-track recording/rewind | Unavailable | Unavailable | Unavailable |

The Windows build result proves the shell compiles and embeds the web artifact. It does not make the executable distributable: bundling/signing, runtime smoke, packaged authentication, and updater policy remain open. It also does not validate a native capture path.

## Windows adapter sequence

1. Define a versioned Rust-to-web contract for capability probing, source identity, errors, cancellation, timestamps, and lifecycle events. Add deterministic fake sources solely for orchestration tests.
2. Prototype Windows Graphics Capture for a user-selected window/process. Confirm game compatibility, cursor policy, exclusive-fullscreen behavior, frame-pool resizing, color space, HDR policy, device loss, and protected-content errors. Keep behind an opt-in experimental flag.
3. Prototype Windows process-loopback capture using the supported process include/exclude activation path. Resolve process-tree semantics, format conversion, silent processes, session churn, elevation boundaries, and exact no-leak tests. Never fall back to whole-system audio without a separate user choice.
4. Bridge native timestamps and bounded frame/audio queues to a WebRTC sender or a local native media pipeline. Establish backpressure and drop policy: preserve audio continuity; drop stale video frames; surface sustained overload.
5. Add hardware encoder selection only after codec capability and sustained-load probes. Capture telemetry records chosen codec/path and fallback reason without process names.
6. Run the physical matrix in `TEST_PLAN.md`. Promote individual hardware/OS combinations from experimental only after passing; keep a kill switch and browser fallback.
7. Implement segmented per-track recording and rewind storage as a separate module with quotas, crash-safe manifest writes, encryption/key lifecycle, and explicit cleanup.

## Later platforms

macOS discovery evaluates ScreenCaptureKit and Core Audio process-tap availability under current OS permissions and distribution rules. Linux discovery separates PipeWire portal capture under Wayland from X11 behavior and documents compositor limitations. Neither platform should reuse Windows status claims. The common adapter exposes `implemented`, `experimental`, or `unavailable` for each independent feature plus a stable reason code.

## Promotion rules

A capability report is generated from compiled support plus runtime probes. Compile target alone is insufficient. `experimental` must never enable automatically after an update. `implemented` requires successful source enumeration and a usable stream in the current session; losing the device transitions state and tells the web client to stop or offer browser fallback.
