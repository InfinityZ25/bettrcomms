# Native Windows sharing

The desktop Share screen button opens a dedicated sharing workspace, keeping the active call mounted. Its searchable application/display gallery loads local thumbnails only as cards approach the visible area; titles truncate without widening the layout. Share and Cancel remain in a fixed footer. It probes installed encoders before offering NVIDIA NVENC, AMD AMF, Intel Quick Sync, or software x264. Controls select H.264 encoding, resolution (up to 4K), 30/60 FPS, bitrate (8/10/12/16/20/40/80 Mbps; default 20), and cursor visibility. Browser sharing remains available explicitly and remains the browser client's default.

Windows Graphics Capture supplies frames to a native FFmpeg encoder. The native WebRTC sender packetizes its H.264 access units directly; the WebView does not re-encode them. Each viewer uses a separate connection with the call's ICE configuration. Direct-only mode removes TURN and relay candidates. One encoder serves up to seven remote viewers plus the local preview. Uplink use grows with viewer count.

This development implementation uses the machine's existing WinGet `Gyan.FFmpeg` installation. It does not download or bundle that distribution. Its GPL-enabled build and codec distribution requirements need a deliberate packaging decision before shipping an installer. A missing runtime or failed encoder probe leaves browser sharing available.

## Recording

Local native screens preserve the same selected encoder and bitrate: a second FFmpeg process remuxes the encoded stream to MP4 using `-c:v copy`. A recording starts at the next IDR frame; the manifest records this offset. Independent microphones, cameras, and received screen tracks retain their separate recording paths. Native MP4 assets transfer through bounded binary IPC chunks into the existing local recording library. Playback volume adjustments do not modify saved assets.

Browser/received-screen recording bitrate is separately selectable in Settings. Defaults are 20 Mbps for screens, 8 Mbps for cameras, and 256 kbps for audio. A session's retained compressed data is capped at 512 MiB; the native staging file is also bounded. Native capture/muxer processes belong to an app-lifetime Windows job and cannot outlive the desktop process.

## Current limits

- Native sharing can include system audio on Windows build 20348 or newer. WASAPI process-loopback explicitly excludes BetterComms and its descendants, including WebView call playback. Selecting only the chosen application audio and injected exclusive-fullscreen game hooks remain unimplemented. Browser sharing retains browser-supported capture options.
- This is H.264 SDR 4:2:0, not AV1/HEVC/HDR or lossless RGB. Some protected, minimized, or exclusive-mode sources cannot be captured.
- Live bitrate is manually selected; native congestion-driven encoder adaptation and ICE restart are not implemented. Two-second IDR frames allow late joining/recovery; immediate encoder response to PLI is not implemented.
- Recording preserves the live encoding profile, not a separate OBS-style archival encoder profile. A clean stop finalizes MP4; active-recording crash recovery and continuous rewind remain future work.
- Cross-network native TURN, 4K60 sustained gameplay, and simultaneous large-group/GPU-denoising load need additional acceptance tests.

## Verification

`scripts/test-native-screen.mjs` connects to a temporary loopback WebView debugging endpoint and captures only its own synthetic browser window. It exercises the actual native encoder, H.264 WebRTC browser decoder, native MP4 remux, frontend preview/recording integration, and cleanup. It writes test MP4s under `.local/capture-probe/` for independent `ffprobe` checks. Do not enable that debugging endpoint in distributed builds.

Use `scripts/start-desktop.ps1` for ordinary development. It runs the Tauri Rust watcher and reuses this workspace's existing Vite server when one is already listening. After native changes, a directly launched old executable can otherwise keep serving new frontend code with an old IPC command registry.


## Encoding efficiency and compatibility

Automatic video compatibility selects the best common H.264 profile (High, Main, then Baseline) reported by the local decoder and current peers. Unknown or nonresponding peers select Baseline. An empty room uses the local decoder capabilities. Capability checks distinguish High 4:2:0 from High 4:4:4; the latter does not establish support for the former. A later incompatible viewer receives an explicit compatibility error; restart sharing with Compatibility / H.264 Baseline for that viewer. There is no automatic midstream profile downgrade.

NVENC uses P6 low-latency tuning, spatial AQ strength 8, temporal AQ, and full-resolution multipass. It retains zero B-frames and zero lookahead, CBR with a half-second VBV, and two-second keyframes. Encoder and SDP levels match the actual dimensions, frame rate, and bitrate. Recording copies these same encoded access units. Stop drains pending recording frames before finalization; stopping before the first IDR produces an actionable error instead of an unusable asset.

Run `scripts/benchmark-nvenc-quality.ps1` for the reproducible synthetic 1080p60 motion/grid/text comparison. The six-second RTX 4070 SUPER result compared the previous Baseline/P5/one-second GOP against Main/P6/two-second GOP:

| Target Mbps | Previous VMAF | Current VMAF | Current actual Mbps | Current encode FPS |
| --- | --- | --- | --- | --- |
| 8 | 91.814 | 94.247 | 8.243 | 122.1 |
| 12 | 95.334 | 96.860 | 12.141 | 116.9 |
| 20 | 98.401 | 98.626 | 20.146 | 123.5 |

Five-second keyframes offered no useful quality improvement in this comparison, so the recovery interval stays at two seconds. These controlled scores do not establish Discord parity, end-to-end latency, or performance while a game saturates the GPU. Existing recordings cannot regain lost detail. H.264 remains 8-bit YUV 4:2:0, so gradient quantization and repeated self-capture can still show bands.

`scripts/test-native-stream-quality.mjs` passed actual Windows Graphics Capture, native RTP decoding in Chromium, and native-copy MP4 inspection for Baseline/Main/High at each of 8/12/20 Mbps, all 1920x1080 at a requested 60 FPS. Baseline and Main at 8 Mbps also passed encoded-frame loss recovery with a new decoded keyframe and late joining. The test captures only its synthetic source window and uses a temporary loopback debugging endpoint. Receiver support varies by browser; unsupported High is skipped explicitly by the harness. Older P4/P5 checks remain in `scripts/test-native-encoder-quality.ps1` as historical comparisons.

## Native system audio and source previews

The share screen has a Share system audio switch, enabled by default when the OS reports support. Capture starts only after Share. It records all other processes rather than just the chosen window; the call, BetterComms playback, and BetterComms notification sounds are excluded through `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`. There is no unrestricted endpoint-loopback fallback. Protected or exclusive audio may not be capturable.

Native PCM is 48 kHz float32 stereo. A bounded 500ms ring returns the newest at most 100ms through binary IPC. An AudioWorklet requests data from its render clock with one request in flight, avoiding window polling timers; its stream is never connected to local speakers. The system track uses the existing WebRTC audio transport and independent recording/mixer path. Stopping sharing, leaving the call, cancellation, and errors release native capture and the system track together. Browser clients keep browser capture.

Verification includes real WASAPI activation/start/stop and a controlled spectral exclusion test: an independent 880Hz sibling process was captured while a 440Hz child of the excluded process was below the leakage threshold. No captured PCM was persisted. Browser tests exercise actual AudioWorklet stereo output, binary pull behavior, cancellation, failure, resource cleanup, and engine screen/audio coupling.

Native preview enumeration reuses opaque IDs for unchanged currently listed windows, so overlapping refreshes do not invalidate visible cards. Deleted sources are removed. The frontend accepts native binary response formats, validates JPEG boundaries, and retries one failed preview; unsupported sources show a refresh hint. A controlled application-window acceptance test produced a 640x360 JPEG through Windows Graphics Capture.
