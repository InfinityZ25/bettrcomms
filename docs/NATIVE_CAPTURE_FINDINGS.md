# Windows native capture and encoder findings

Probe date: 2026-09-05. This document distinguishes native recording from browser WebRTC delivery. No real desktop, window, or audio was captured during the probe; encoder checks used a generated test pattern.

## Practical conclusion

A useful first Windows slice is implementable now:

1. Invoke the Windows system `GraphicsCapturePicker` from the Tauri window. It gives the user an OS-controlled window/display choice and cancellation path.
2. Capture the selected `GraphicsCaptureItem` with Windows Graphics Capture (WGC) into a bounded pool of D3D11 textures. Keep cursor and border controls explicit, recreate the pool on resize, and stop on item closure, device loss, disconnect, or user action.
3. Capture selected-process audio and its children with WASAPI process loopback as a separate timestamped track. Stop it with the screen source.
4. Feed native frames to WebView2 for the current browser WebRTC path while describing the live encoder as browser/WebRTC controlled.
5. In parallel, encode the same native textures to a local recording with a user-selected native hardware encoder and explicit quality settings. This is the first place where an OBS-style encoder selector is truthful.

This slice improves picker behavior, source control, process audio, and recording quality without claiming that the selected native encoder sends the live WebRTC track. Browser `getDisplayMedia()` remains the fallback when native capture is unavailable or rejected.

True end-to-end live encoder selection is a second transport milestone. It requires the native process to own the outgoing WebRTC sender and packetize its encoded H.264/AV1 output. Passing decoded native frames into a browser `MediaStreamTrack` causes Chromium to encode them again. Decoding native output with WebCodecs and creating a browser track has the same problem. WebRTC Encoded Transform cannot originate frames: the specification says a processor cannot create frames or move them between streams ([W3C specification](https://www.w3.org/TR/webrtc-encoded-transform/)).

## Capture API choice

Microsoft documents WGC as the API for acquiring display or application-window frames for collaborative applications. Its system picker provides explicit selection, Windows draws an active-capture border, and desktop callers associate the picker with their HWND ([Microsoft screen-capture documentation](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture)). This matches the product's explicit and revocable selection requirement better than silently enumerating and opening targets.

[`windows-capture` 2.0.1](https://github.com/NiiightmareXD/windows-capture), pinned during this review at commit `c7d106448eb9d9b251345c39047711e1cd408ae2`, is MIT-licensed Rust and already wraps:

- the system `GraphicsCapturePicker`, including Win32 owner-window initialization and cancellation;
- WGC and DXGI Desktop Duplication frame paths;
- D3D11 textures and frame callbacks;
- a Media Foundation `MediaTranscoder` recording helper with hardware acceleration enabled;
- video bitrate, frame rate, dimensions and H.264/HEVC subtype;
- AAC audio and output to a file or `IRandomAccessStream`.

It is a good prototype/reference, but its recording helper exposes only `SetHardwareAccelerationEnabled(true)`. It does not provide a stable promise that a named NVIDIA, AMD, or Intel encoder was selected, nor the rate-control, GOP, B-frame, lookahead, AQ, low-latency and quality controls expected from an OBS-style selector. Recent open issues also report iGPU shutdown failure, first-frame size changes, color distortion and failure to achieve a 16.67 ms update interval. Those are reasons to pin and acceptance-test the crate, and possibly use direct `windows` bindings for the production frame loop. They are not proof that WGC itself is unsuitable.

Recommended boundary: use WGC/WinRT types directly or behind a small internal trait. Treat `windows-capture` as an optional implementation aid rather than exposing its types across Tauri commands. The native adapter should return source identity, size, cursor/border state, timestamp, availability reason and bounded-frame diagnostics. It must never return arbitrary HWND capture as if the user selected it.

## Process audio

Microsoft's Application Loopback sample uses `ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_PARAMS` to capture one PID and its child process tree. It requires Windows 10 build 20348 or later and produces silence when the process tree has no rendering stream ([official sample](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback)). Ordinary WASAPI endpoint loopback captures the complete endpoint mix and is therefore not an acceptable silent substitute ([Microsoft loopback documentation](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)).

The implementation should timestamp float PCM from `IAudioCaptureClient` against the same monotonic session clock as WGC frames, resample only at the encoder/WebRTC boundary, and retain it as an independent logical source. Process exit, format change, activation failure, protected audio and silence need distinct status. Ending screen capture ends this audio capture and releases the client, callback, event and buffers.

## Encoder control options

| Path | Selection/control | Redistribution | Recommended role |
|---|---|---|---|
| Media Foundation hardware MFT | Enumerate `MFT_CATEGORY_VIDEO_ENCODER` with `MFT_ENUM_FLAG_HARDWARE`; retain the activated MFT identity and configure `ICodecAPI` | Windows component; no vendor runtime bundled | Baseline explicit encoder discovery and H.264 recording/live experiments |
| NVIDIA NVENC | Explicit device/session; detailed preset, tuning, RC, GOP, AQ, lookahead and B-frame control | Driver supplies `nvEncodeAPI64.dll`; SDK headers/API are under NVIDIA's Video Codec SDK agreement | NVIDIA high-quality recording and later native RTP |
| AMD AMF | Explicit AMF context/device; ultra-low-latency, low-latency-high-quality, CBR/VBR/QVBR/HQVBR, GOP and async-depth controls | AMF SDK repository is MIT; driver supplies AMF runtime. Codec patent rights are expressly outside the SDK license | AMD recording and later native RTP |
| Intel oneVPL/QSV | Explicit implementation/device selection and detailed encode properties | oneVPL loader/API is MIT; GPU runtime normally comes with Intel driver | Intel recording and later native RTP |
| `windows-capture` MediaTranscoder | Hardware acceleration on/off, codec, bitrate, frame rate and dimensions | Crate MIT; Windows codecs | Fast recording prototype, not a named-encoder guarantee |
| FFmpeg | Mature wrappers for NVENC, AMF, QSV and muxing | Depends on exact build; the installed binary is GPLv3-enabled and unsuitable as an unreviewed bundled dependency | Local probing only unless a deliberately compliant distribution is built |

Media Foundation hardware transforms are asynchronous and advertise their hardware device association ([Microsoft hardware-MFT documentation](https://learn.microsoft.com/en-us/windows/win32/medfound/hardware-mfts)). Enumeration must instantiate and test a short synthetic encode; names and registration alone do not prove readiness. Report the activated transform/vendor and settings, and visibly fall back when it fails.

AMD's [AMF SDK](https://github.com/GPUOpen-LibrariesAndSDKs/AMF) is MIT and supports recent Radeon GPUs/APUs. Its H.264 API defines ultra-low-latency and low-latency presets, but its notice explicitly grants no codec patent license ([AMF encoder documentation](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/blob/master/amf/doc/AMF_Video_Encode_API.md)). NVIDIA exposes H.264, HEVC and AV1 plus high-quality, low-latency, ultra-low-latency and lossless tuning ([NVENC guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)); use of SDK headers and redistributed SDK components must follow NVIDIA's SDK agreement. Intel oneVPL is the portable Intel media API ([Intel overview](https://www.intel.com/content/www/us/en/docs/oneapi/programming-guide/2023-2/intel-oneapi-video-processing-library-onevpl.html)). H.264/HEVC/AV1 distribution and patent review is separate from SDK source-code licenses.

## Settings that should be exposed

Keep live and recording profiles separate because they optimize for different outcomes.

For live H.264: constrained-baseline or interoperable main profile after negotiation; CBR or latency-constrained VBR; no B-frames; no lookahead; one-frame/low async depth; two-second IDR interval plus keyframes on receiver request; bounded VBV; 4:2:0 NV12; bitrate tied to negotiated resolution, frame rate and network feedback. Do not promise AV1 until every receiver negotiates it.

For recording H.264/HEVC/AV1: constant-quality or quality-constrained VBR; high-quality preset; AQ enabled where available; B-frames/lookahead allowed; two-second GOP; higher bitrate or quality target; MKV or fragmented MP4 for crash tolerance, followed by a final remux when needed. A second encoder session is preferable to reusing the low-latency WebRTC bitstream. Probe session limits and GPU load before enabling simultaneous live and recording encodes.

The UI should show `Auto`, concrete ready encoders such as `NVIDIA NVENC H.264` or `AMD AMF H.264`, and `Software` only after a real frame test. Save the stable adapter LUID and encoder implementation identity rather than a transient ordinal. Diagnostics should expose requested encoder, active encoder, codec/profile, resolution/fps, rate control, bitrate/quality, dropped frames and fallback reason.

## Local synthetic encoder evidence

Installed FFmpeg 8.1 lists NVENC, AMF and QSV wrappers. Its build has GPL and version-3 features enabled, so this binary is probe infrastructure only. A generated 1920×1080 60 fps, three-second pattern was encoded to H.264 at 8 Mbit/s with no audio or screen capture:

| Encoder | Result | FFmpeg processing time | Speed | Output bytes |
|---|---:|---:|---:|---:|
| NVIDIA NVENC, P4 + ultra-low-latency, CBR, no B-frames | Passed | 0.479 s | 6.26× realtime | 3,001,794 |
| AMD AMF, ultra-low-latency + speed, CBR, async depth 1, no B-frames | Passed | 0.630 s | 4.74× realtime | 3,024,295 |
| Intel QSV | Failed to create an MFX session | 0.10 s before failure | n/a | 0 |

This proves that the installed RTX 4070 SUPER NVENC and Ryzen integrated Radeon AMF paths can encode synthetic 1080p60 on the current drivers. It does not measure WGC-to-bitstream latency: the source was generated in memory and format conversion/FFmpeg overhead is included. A capture integration gate should measure capture timestamp to encoded access-unit availability, p50/p95/p99, over at least five minutes while the selected application renders motion.

Raw logs and generated probe files are in `.local/capture-probe/`.

## Native live WebRTC milestone

For a selected native encoder to truly own live delivery, the Tauri process must negotiate its own video transceiver with every remote peer (or with the future SFU), packetize the exact encoder access units, process RTCP feedback, force IDRs for PLI/FIR, pace RTP, retransmit/NACK where supported, and apply congestion-control decisions back to bitrate/resolution/frame rate.

[`str0m`](https://github.com/algesten/str0m) is a viable Rust transport candidate: it is MIT/Apache-2.0, tested on Windows, accepts complete encoded H.264/VP8/VP9/AV1 frames through `Writer::write`, packetizes them, and supports an RTP-level mode. It deliberately supplies no capture or encoder.

The bounded sender spike in `apps/desktop/src-tauri/src/native_screen_rtc.rs` uses exact crate version `webrtc = "=0.17.2"`. It compiles on the repository's Windows stable Rust toolchain and its Annex-B/direct-only unit tests pass in the isolated `.local/capture-probe/rtc-check` crate. It registers only H.264 constrained baseline (`profile-level-id=42e01f`, `packetization-mode=1`), broadcasts one shared encoded access unit to at most eight peers, gathers a full offer before returning, bounds access-unit size/duration, filters relay configuration and candidates in direct-only mode, drains RTCP, and coalesces PLI/FIR into an encoder keyframe request. Peer removal and hub closure abort the RTCP reader and close each peer connection. Version 0.17.1 was rejected because its currently resolved `webrtc-sctp` dependency failed to compile due an incompatible `Config` initializer; the exact 0.17.2 graph compiled.

This is transport evidence, not the browser acceptance gate. The spike has not yet completed a real browser answer, RTP decode, TURN relay, ICE restart, loss recovery, congestion-control-to-encoder feedback, or multi-peer teardown run. Periodic one-second IDRs remain the capture encoder's responsibility; PLI/FIR can request the next IDR through `take_idr_request`.

For H.264, negotiate `packetization-mode=1` and a compatible `profile-level-id`; convert the encoder output to the packetizer's expected Annex-B/access-unit form; retain SPS/PPS; send them with/preceding IDR as required; preserve monotonic 90 kHz timestamps; and translate receiver PLI into an immediate forced IDR. The native peer must publish the same source metadata and authorization identity as the browser call. A hidden local-native peer bridged back through the WebView would still decode/re-encode and is not the desired path.

## Acceptance gates

Native picker/capture is ready only after system-picker cancel/select, window close, resize, minimize, protected/elevated target, device loss, 30-second renderer stall, stop/disconnect and repeated start/stop tests release every texture, frame-pool handler and audio object. The test must verify the capture indicator and must not use unconsented programmatic desktop capture.

Recording encoder selection is ready only when the requested adapter and encoder are proven by an encoded synthetic frame, output decodes, timestamps are monotonic, cancellation finalizes or retains a recoverable partial file, and a forced failure yields a visible named fallback. Measure quality with representative text/game motion using VMAF/SSIM plus visual inspection, and compare file size at equal duration.

Native WebRTC encoder selection is ready only when receiver stats and captured RTP identify the chosen codec/profile, the native encoder reports the same active implementation, no Chromium encode occurs for that source, bitrate adaptation and PLI recovery work, TURN relay works, and every peer path cleans up. Until those broader production gates pass, treat native sharing as a development implementation; report the actual native encoder and the unsupported network/recovery features accurately.
# Implementation update

The research above describes alternatives and production packaging gates. The local development implementation now uses the already-installed FFmpeg runtime for WGC and NVENC/AMF H.264, with the native WebRTC sender and pass-through MP4 recording described in [NATIVE_SHARING.md](NATIVE_SHARING.md). Real NVIDIA and AMD 720p60 capture/browser decode and frontend native recording acceptance passed on 2026-09-05. No FFmpeg distribution is bundled; broader network, game, and packaging gates remain open.

