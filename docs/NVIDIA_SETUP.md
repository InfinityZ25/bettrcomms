# NVIDIA Audio Effects setup

Bettercomms can install the NVIDIA Audio Effects SDK 1.6.1.2 Ada runtime into the current user's application data directory. This is an optional Windows component; browser capture and standard noise suppression remain available without it.

The initial installer supports detected NVIDIA Ada GPUs, including GeForce RTX 40-series hardware. The desktop reports the detected adapter, eligibility, installed state, selected package, and the 706,540,584-byte download before installation. Other NVIDIA architectures remain unsupported until their official package URLs, hashes, signatures, and hardware acceptance tests are recorded.

The `nvidia_install` desktop command accepts no URL or path. It downloads the pinned package from NVIDIA and the pinned standalone 7-Zip extractor, enforces size limits and a 30-minute network timeout, checks both SHA-256 hashes, and requires a valid NVIDIA Authenticode signer on the SDK installer. It extracts in a per-user staging directory and publishes a complete runtime atomically to `%LOCALAPPDATA%\Bettercomms\nvidia-audio-effects`.

The installed directory contains:

- `setup.json`, schema version 1
- `runtime/NVAudioEffects.dll` and its CUDA, TensorRT, and OpenSSL runtime dependencies
- `models/denoiser_48k.trtpkg`
- `notices/` with NVIDIA license PDFs and third-party notices

The NVIDIA installer is not executed; a pinned standalone extractor unpacks its payload. No service is installed, and neither system directories nor global `PATH` are changed. The application loads only the DLL and model paths named by the manifest. Close Bettercomms before removing the `nvidia-audio-effects` directory to uninstall this private runtime.

The NVIDIA package remains subject to its included [SDK license](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-software-license-agreement/) and [product-specific terms for AI products](https://www.nvidia.com/en-us/agreements/enterprise-software/product-specific-terms-for-ai-products/). Preserve the copied notices and satisfy the included distribution conditions for public releases. File installation alone does not establish processing readiness: `nvidia_status` must load the SDK/model and successfully process a 48 kHz frame. Physical audio quality and sustained game-load acceptance remain separate gates in `docs/TEST_PLAN.md`.

## Audio path and validation

The webview captures the selected microphone and passes mono 48 kHz frames from an AudioWorklet directly to a dedicated Web Worker over a transferred MessagePort. The worker exchanges binary frames with a dedicated native SDK thread over an authenticated, ephemeral loopback WebSocket. Audio frames never pass through the UI thread; the model warms before capture starts. Processed audio returns to a MediaStream destination used by the existing WebRTC engine. No virtual microphone or NVIDIA Broadcast application is required. GPU noise suppression is independent of video encoding.

The bridge keeps one native request in flight and bounds queued audio to 240 ms (24 ten-millisecond frames or 12 twenty-millisecond frames). Playback starts with 40 ms buffered; an underrun attempts recovery with an 80 ms buffer. Late output beyond the target plus two frames is trimmed to keep latency bounded. It never mixes delayed processed audio with current raw input. A 250 ms request/recovery timeout, queue overflow, fourth underrun within ten seconds, or native error triggers a visible RNNoise fallback. An isolated stall can cause an audible gap while recovering. Two native sessions allow capture replacement, and abandoned sessions expire after ten seconds without audio requests.

Successful native readiness probes are cached for 60 seconds. Model initialization is serialized across probes and stream startup, with a second active-stream check after waiting. This prevents repeated Settings visits and concurrent startup from loading unnecessary models. A cached readiness result can be stale for less than a minute; actual stream startup still validates the SDK. The vendor's synchronous GPU calls cannot be forcibly interrupted if the driver hangs.

The RTX 4070 SUPER on this Windows host passed actual SDK model loading and frame processing, plus repeated native WebView AudioWorklet integration checks. These checks use a synthetic audio source and prove the native path, finite output, ownership cleanup, and session reuse. Physical microphone quality, game-load contention, and longer call acceptance still need testing.

Packaged Wails GPU audio acceptance remains outstanding. Use the Wails Go tests and frontend unit tests for automated coverage, then verify real SDK loading, frame processing, fallback, and cleanup on supported hardware before release.
