# Browser noise suppression

## Implemented adapter

`apps/web/src/media/denoise.ts` exposes:

```ts
createDenoiser(rawTrack): Promise<{ track: MediaStreamTrack; dispose(): void }>
```

It creates a private 48 kHz `AudioContext`, loads the normal and SIMD RNNoise WebAssembly assets through Vite `?url` imports, installs the package AudioWorklet, and routes one mono input through `RnnoiseWorkletNode` into a `MediaStreamAudioDestinationNode`. The graph never connects to `AudioContext.destination`, so it does not play the microphone through local speakers.

The caller owns the raw input track. `dispose()` is idempotent and stops only the generated processed track, disconnects every node, destroys the RNNoise worklet node, and closes the private context. Setup failures run the same cleanup. The caller must stop the raw track when microphone capture should end.

The implementation follows the package maintainer's [official Vite usage and demo](https://github.com/sapphi-red/web-noise-suppressor): `loadRnnoise` receives the base and SIMD WASM URLs, `audioWorklet.addModule` loads `rnnoiseWorklet.js`, and `RnnoiseWorkletNode.destroy()` releases its worklet resources. The package requires AudioWorklet. BetterComms reports an error when AudioWorklet is absent rather than silently claiming RNNoise is active.

## Bundle impact

The published package version inspected during implementation was 0.4.0, with an npm-reported unpacked package size of 903,704 bytes across 25 files. The three imported assets in that package are 152,656 bytes for `rnnoise.wasm`, 157,234 bytes for `rnnoise_simd.wasm`, and 64,433 bytes for `rnnoiseWorklet.js`: 374,323 bytes uncompressed before Vite transforms or transport compression. Vite emits the imported worklet and both WASM variants as build assets; the production build report must record their exact emitted and compressed sizes. Serving both normal and SIMD URLs permits runtime selection while retaining compatibility.

## Browser verification

Implementation evidence on 2026-09-05: `npx playwright test tests/denoise.spec.ts --reporter=line` passed in Chromium against the live Vite server (1 test, 1.7 seconds). The test generated a 48 kHz oscillator track without microphone access, dynamically loaded the real Vite module, observed nonzero samples after RNNoise, disposed twice, confirmed the processed track ended, and confirmed the raw track remained live until caller teardown. This proves the adapter's basic browser data flow and ownership behavior; it does not replace the quality, stress, or multi-browser work below.

Run these tests in a real Chromium browser or Tauri WebView2 because jsdom cannot execute AudioWorklet or WASM processing:

1. Create a synthetic 48 kHz audio source with an `OscillatorNode` plus controlled noise, route it into a `MediaStreamAudioDestinationNode`, and pass its audio track to `createDenoiser`.
2. Assert the returned track exists, has kind `audio`, remains `live`, and can be attached to a second `AudioContext` analyser or `MediaRecorder` without connecting the denoiser graph to speakers.
3. Confirm samples or encoded data arrive after worklet startup. A live track alone does not prove that RNNoise is processing.
4. Call `dispose()` twice. Assert the processed track becomes `ended`, the private context closes, and the synthetic raw track remains live. Then stop the raw track in the test owner's teardown.
5. Stop the raw track before setup and confirm the adapter rejects without leaving a context or output track alive.
6. Exercise setup failures for blocked worklet URL and blocked WASM URL and verify cleanup with browser instrumentation.
7. Run with WebAssembly SIMD enabled and disabled. Both paths must produce audio; record startup latency, processing latency, CPU, underruns, and emitted asset requests.
8. Repeat create/dispose for 100 iterations and compare contexts, worklet nodes, tracks, and heap after garbage collection in a diagnostic browser run. There must be no growing live-resource count or microphone indicator after the raw owner also stops capture.

For quality acceptance, use timestamped clean speech mixed with repeatable fan, keyboard, and broadband-noise fixtures. Compare bypass, browser-standard suppression, and RNNoise for speech intelligibility, attenuation, clipping, artifacts, CPU, and end-to-end latency. RNNoise remains optional and must fall back to the caller's raw/browser-processed track if creation fails.

## Native GPU processing

The Windows desktop integrates the NVIDIA Audio Effects SDK directly; see [NVIDIA setup](NVIDIA_SETUP.md). It also offers DeepFilterNet3 through DirectML on AMD/Intel graphics. Both share a bounded, authenticated loopback Worker/AudioWorklet transport and use explicit RNNoise fallback when a native engine cannot keep up. Browser clients retain standard, RNNoise and Speex processing and never invoke native GPU commands.

DeepFilterNet selects a native DXGI AMD/Intel adapter, disables CPU execution fallback, validates the complete model on that GPU, and checks frame timing before reporting readiness. Its 48 kHz mono model uses 512-sample hops and has 32 ms of algorithmic delay; the transport normally buffers about 43 ms in addition to capture/playback latency. Maximum attenuation blends in a dry path delayed by exactly 1,536 samples. At 0 dB the output is delayed unfiltered input; 100 dB uses the full model output. This setting caps suppression rather than guaranteeing a measured reduction for every sound.

See [DeepFilterNet setup](DEEPFILTER_SETUP.md) for private runtime packaging and [AMD model findings](AMD_MODEL_FINDINGS.md) for graph conversion, provenance and actual integrated Radeon measurements. Intel is capability-probed but has not been tested on physical Intel hardware here. Krisp remains deferred because its commercial SDK and license are unavailable.
