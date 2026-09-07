# DeepFilterNet3 WebAssembly evaluation

BetterComms integrates `deepfilternet3-noise-filter` 1.3.0 as an experimental,
explicitly selected browser and desktop-WebView engine. It is not the default.
The adapter lazy-loads the package, processes a mono 48 kHz microphone in an
AudioWorklet, never connects it to local speakers, and releases its output,
nodes, model wrapper, and private AudioContext on disposal. Setup errors and
surfaced AudioWorklet processor errors switch the caller to RNNoise. The
upstream worklet catches some model-constructor failures internally and emits
unchanged audio, which is why signal-level acceptance is required too.

The model and WASM are served from the BetterComms origin, so microphone startup
does not depend on Mezon's CDN. They were fetched from the package's documented
v3 asset URLs on 2026-09-07:

- `df_bg.wasm`: 16,418,651 bytes, SHA-256
  `440b5d12b6ea7d95008736f844221d7874ee15de5cb10d3015002470fdba0432`
- `DeepFilterNet3_onnx.tar.gz`: 7,983,136 bytes, SHA-256
  `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616`

The package and assets are MIT or Apache-2.0 licensed. Copies of both licenses
ship beside the web assets. The npm package is pinned by `package-lock.json`.

## Acceptance result

Chromium loaded the real v1.3.0 worklet and self-hosted assets, produced a live
mono track in about 0.12 seconds with a warm HTTP cache, sustained output for a
five-second probe, and released the generated track without stopping its input.

It did not pass signal-quality acceptance. The pinned noisy-speech fixture
`noisy_2s_48k.wav` from `deepfilter-stream` was fed through the published v1.3
worklet at 100 dB attenuation. After aligning the 960-sample delay, output was
sample-for-sample equal to the input (correlation 1, scale 1, residual RMS 0).
The corresponding known-good native reference reduces overall RMS by about
3.06 dB. The v1.2.1 package and documented v2 assets showed the same bypass in
this environment. Upstream also has an unresolved realtime crackling report.

Because a live output track only proves data flow, not enhancement, BetterComms
labels this engine experimental and keeps the already validated RNNoise adapter
as the default on web and native. Do not promote the WASM engine until a pinned
upstream build both changes the noisy fixture toward its reference and passes a
long realtime microphone test without worklet errors, crackling, or underruns.
