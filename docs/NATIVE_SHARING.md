# Native Windows sharing

The desktop Share screen button opens a dedicated sharing workspace, keeping the active call mounted. Its searchable application/display gallery loads local thumbnails only as cards approach the visible area; titles truncate without widening the layout. Share and Cancel remain in a fixed footer. It probes installed encoders before offering NVIDIA NVENC, AMD AMF, Intel Quick Sync, or software x264. Controls select H.264 encoding, resolution (720p through 4K or source-native), 30/60/120 FPS presets, custom 15–240 FPS, preset bitrates, custom 1–200 Mbps, and cursor visibility. Browser sharing remains available explicitly and remains the browser client's default.

Windows Graphics Capture supplies frames to a native FFmpeg encoder. The native WebRTC sender packetizes its H.264 access units directly; the WebView does not re-encode them. Each viewer uses a separate connection with the call's ICE configuration. Direct-only mode removes TURN and relay candidates. One encoder serves up to seven remote viewers plus the local preview. Uplink use grows with viewer count.

Starting with Windows 0.1.10, the installer includes the pinned Gyan FFmpeg 8.1 executable as a Tauri resource beside its GPL license, setup metadata, and source/build references. The release workflow checks the pinned file lengths and SHA-256 values before building each Windows installer. Rust uses this packaged runtime first, so a fresh install needs no WinGet command, PATH change, restart, or separate runtime setup. The existing verified download into `%LOCALAPPDATA%\Bettercomms\ffmpeg-8.1` remains a repair fallback when packaged files are missing; an existing WinGet installation remains a final compatibility fallback for screen capture. A missing runtime or failed encoder probe leaves browser sharing available.

The pinned archive is 247,913,948 bytes with SHA-256 `587B1C37DE29C5003D01CF65DA10001BAC43A58B88E61AF0FC77C61DAFF04761`. The extracted FFmpeg executable is 223,360,000 bytes with SHA-256 `D1E2A156261ECC675081943197A85F08F2868784A0AF499171EDE89353EDAD31`. The runtime is GPL-3.0 licensed. `LICENSE` and `SOURCE.txt` are distributed beside the executable.

## Recording

Local native screens preserve the same selected encoder and bitrate: a second FFmpeg process remuxes the encoded stream to MP4 using `-c:v copy`. A recording starts at the next IDR frame; the manifest records this offset. Independent microphones, cameras, and received screen tracks retain their separate recording paths. Native MP4 assets transfer through bounded binary IPC chunks into the existing local recording library. Playback volume adjustments do not modify saved assets.

Browser/received-screen recording bitrate is separately selectable in Settings. Defaults are 20 Mbps for screens, 8 Mbps for cameras, and 256 kbps for audio. A session's retained compressed data is capped at 512 MiB; the native staging file is also bounded. Native capture/muxer processes belong to an app-lifetime Windows job and cannot outlive the desktop process.

## Current limits

- Native sharing can include audio on Windows build 20348 or newer. Application-window sharing uses WASAPI process-loopback include mode for that window's live process tree; other applications are excluded. Windows exposes this at process-tree granularity, so separate windows owned by the same process cannot be isolated. Entire-screen sharing retains system audio with BetterComms and its descendants excluded. A stale or unsupported application selection fails explicitly and never falls back to all system audio. Injected exclusive-fullscreen game hooks remain unimplemented. Browser sharing retains browser-supported capture options.
- This is H.264 SDR 4:2:0, not AV1/HEVC/HDR or lossless RGB. Some protected, minimized, or exclusive-mode sources cannot be captured.
- Live bitrate is manually selected; native congestion-driven encoder adaptation and ICE restart are not implemented. Two-second IDR frames allow late joining/recovery; immediate encoder response to PLI is not implemented.
- Recording preserves the live encoding profile, not a separate OBS-style archival encoder profile. A clean stop finalizes MP4; active-recording crash recovery and continuous rewind remain future work.
- Cross-network native TURN, 4K60 sustained gameplay, and simultaneous large-group/GPU-denoising load need additional acceptance tests.

## Verification

`scripts/test-native-screen.mjs` connects to a temporary loopback WebView debugging endpoint and captures only its own synthetic browser window. It exercises the actual native encoder, H.264 WebRTC browser decoder, native MP4 remux, frontend preview/recording integration, and cleanup. It writes test MP4s under `.local/capture-probe/` for independent `ffprobe` checks. Do not enable that debugging endpoint in distributed builds.

Use `scripts/start-desktop.ps1` for ordinary development. It runs the Tauri Rust watcher and reuses this workspace's existing Vite server when one is already listening. After native changes, a directly launched old executable can otherwise keep serving new frontend code with an old IPC command registry.

## Encoding efficiency and compatibility

Automatic video compatibility selects the best common H.264 profile (High, Main, then Baseline) reported by the local decoder and current peers. Unknown or nonresponding peers select Baseline. An empty room uses the local decoder capabilities. Capability checks distinguish High 4:2:0 from High 4:4:4; the latter does not establish support for the former. A later incompatible viewer receives an explicit compatibility error; restart sharing with Compatibility / H.264 Baseline for that viewer. There is no automatic midstream profile downgrade.

NVENC uses P6 low-latency tuning, spatial AQ strength 8, temporal AQ, and full-resolution multipass. It retains zero B-frames and zero lookahead, CBR with a half-second VBV, and two-second keyframes. Encoder and SDP levels match the actual dimensions, frame rate, and bitrate. Unsupported dimension/rate combinations above H.264 Level 5.2, including 1440p240, are rejected before capture instead of advertising an invalid stream. Recording copies these same encoded access units and scales its bounded queue for high-refresh input. Stop drains pending recording frames before finalization; stopping before the first IDR produces an actionable error instead of an unusable asset.

Run `scripts/benchmark-nvenc-quality.ps1` for the reproducible synthetic 1080p60 motion/grid/text comparison. The six-second RTX 4070 SUPER result compared the previous Baseline/P5/one-second GOP against Main/P6/two-second GOP:

| Target Mbps | Previous VMAF | Current VMAF | Current actual Mbps | Current encode FPS |
| ----------- | ------------- | ------------ | ------------------- | ------------------ |
| 8           | 91.814        | 94.247       | 8.243               | 122.1              |
| 12          | 95.334        | 96.860       | 12.141              | 116.9              |
| 20          | 98.401        | 98.626       | 20.146              | 123.5              |

Five-second keyframes offered no useful quality improvement in this comparison, so the recovery interval stays at two seconds. These controlled scores do not establish Discord parity, end-to-end latency, or performance while a game saturates the GPU. Existing recordings cannot regain lost detail. H.264 remains 8-bit YUV 4:2:0, so gradient quantization and repeated self-capture can still show bands.

`scripts/test-native-stream-quality.mjs` passed actual Windows Graphics Capture, native RTP decoding in Chromium, and native-copy MP4 inspection for Baseline/Main/High at each of 8/12/20 Mbps, all 1920x1080 at a requested 60 FPS. Baseline and Main at 8 Mbps also passed encoded-frame loss recovery with a new decoded keyframe and late joining. The test captures only its synthetic source window and uses a temporary loopback debugging endpoint. Receiver support varies by browser; unsupported High is skipped explicitly by the harness. Older P4/P5 checks remain in `scripts/test-native-encoder-quality.ps1` as historical comparisons.

The parameterized `scripts/test-native-screen.mjs` also passed 1280×720 at 120 FPS/12 Mbps and 240 FPS/20 Mbps through actual Windows Graphics Capture, NVENC and AMF, native RTP, Chromium decoding, and native MP4 recording. Measured decode rates on the development machine were approximately 120.5–120.7 FPS and 240.9–241.4 FPS. Those results establish the pipeline and tested hardware path; a static or slower-refresh source, encoder saturation, receiver decode limits, or network capacity can reduce the delivered rate.

## Native system audio and source previews

The share screen has a Share audio switch, enabled by default when the OS reports support. Capture starts only after Share. A selected application resolves its PID from the native picker's opaque, current window catalog and uses `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`; JavaScript cannot supply a PID or HWND. Entire-screen sharing identifies the one live WebView2 browser process directly parented by BetterComms and uses `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` on that process, excluding its renderer and Chromium audio-service descendants. Missing or ambiguous WebView ownership fails instead of risking call echo. Call-audio exclusion defaults on; an explicit user opt-in can use ordinary default render-endpoint loopback to include the entire system, including the call. The `callAudioControl` capability prevents older native hosts from being offered this choice. Protected or exclusive audio may not be capturable.

Native PCM is 48 kHz float32 stereo. A bounded 500ms ring returns the newest at most 100ms through binary IPC. An AudioWorklet requests data from its render clock with one request in flight, avoiding window polling timers; its stream is never connected to local speakers. The system track uses the existing WebRTC audio transport and independent recording/mixer path. Stopping sharing, leaving the call, cancellation, and errors release native capture and the system track together. Browser clients keep browser capture.

Verification includes real WASAPI activation/start/stop and a controlled spectral exclusion test: an independent 880Hz sibling process was captured while a 440Hz child of the excluded process was below the leakage threshold. No captured PCM was persisted. Browser tests exercise actual AudioWorklet stereo output, binary pull behavior, cancellation, failure, resource cleanup, and engine screen/audio coupling.

The packaged WebView exclusion harness `scripts/test-native-call-audio.mjs` plays 770Hz through a real WebView `AudioContext` while an unrelated FFplay process plays 660Hz. On the same isolated debug host, excluding the old BetterComms root produced WebView magnitude `0.192614`; excluding the directly owned WebView2 browser tree reduced it to `0.000003663`, while the unrelated tone remained effectively unchanged (`0.017457` versus `0.017290`). This confirms WebView call playback is attributed to Chromium's audio-service process and verifies the new exclusion target on this Windows host.

Native preview enumeration reuses opaque IDs for unchanged currently listed windows, so overlapping refreshes do not invalidate visible cards. Deleted sources are removed. The frontend accepts native binary response formats, validates JPEG boundaries, and retries one failed preview; unsupported sources show a refresh hint. A controlled application-window acceptance test produced a 640x360 JPEG through Windows Graphics Capture.

## Native camera overlay

The optional Windows camera overlay is a native layered tool window rather than a second WebView. The trusted main app sends a bounded composite RGBA frame through binary IPC targeting 24 FPS (0.1.9+); early frames are paced instead of dropped. A random overlay grant, exact current dimensions, a 2.3 MiB frame ceiling, serialized lifecycle operations, and a five-second frame heartbeat prevent stale calls or abandoned overlays from remaining visible. One to four 16:9 camera rows are supported at small, medium, or large widths; layouts that exceed the current monitor work area are proportionally reduced and the returned dimensions are authoritative. The window is topmost, does not activate or appear in the taskbar, can be click-through, and is excluded from Windows display capture on supported OS builds.

The WebView disables Chromium background timer and renderer throttling so its existing camera tracks can keep producing overlay frames while another app has focus. The overlay does not open a camera device or create another camera pipeline. It works above desktop, windowed, and borderless applications. An exclusive-fullscreen game can cover topmost desktop windows; use borderless/windowed mode when the overlay is not visible. Protected-content and OS capture-exclusion behavior remains controlled by Windows.
