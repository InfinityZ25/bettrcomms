# AMD DirectML speech-denoising probe

Probe date: 2026-09-05. Status: feasible on the installed Ryzen 7 7800X3D integrated Radeon, using a DirectML-adjusted DeepFilterNet3 streaming graph. This is a bounded synthetic inference result, not physical-microphone quality acceptance.

## Result

The tested model is the `model-dfn3-512-v1` full streaming ONNX export from [`wuxuedaifu/deepfilter-stream`](https://github.com/wuxuedaifu/deepfilter-stream), pinned at commit `be1a989760c93f3107c0c39a6d866df8d6bd40b2`. Its release assets are at:

`https://github.com/wuxuedaifu/deepfilter-stream/releases/download/model-dfn3-512-v1/`

It derives from [`Rikorose/DeepFilterNet`](https://github.com/Rikorose/DeepFilterNet), pinned for this review at tag `v0.5.6`, commit `978576aa8400552a4ce9730838c635aa30db5e61`. DeepFilterNet is dual MIT/Apache-2.0. The wrapper is MIT and includes a `NOTICE` identifying the graph as a DeepFilterNet3 `torchDF` streaming export. The source and wrapper licenses allow redistribution when their notice/license obligations are retained. Product distribution should include the chosen upstream license and the wrapper/model attribution notice.

The stock graph runs, but it is a poor DirectML artifact: 15 `com.microsoft::FusedConv` nodes execute on the CPU. On AMD it measured 4.538 ms mean and 5.272 ms p95 per 10.667 ms frame. The adjusted graph replaces each `FusedConv(activation=Relu|Sigmoid)` with an equivalent standard ONNX `Conv` followed by its activation. CPU output from the adjusted graph was bit-identical to the stock graph for 1,000 deterministic stateful frames. This change moved the complete measured graph to DirectML. A session with `session.disable_cpu_ep_fallback=1` initialized and processed frames successfully; an ONNX Runtime profile recorded only `DmlExecutionProvider` node events (DFT, five GRUs and 14 DML-fused partitions), with no CPU EP node event.

On explicit DirectML adapter index 1, the installed AMD Radeon processed 1,000 post-warmup frames as follows:

| Metric | AMD DirectML | CPU EP | Stock hybrid AMD |
|---|---:|---:|---:|
| Session initialization | 382.2 ms | 39.4 ms | 290.5 ms |
| Mean frame inference | 2.588 ms | 1.452 ms | 4.538 ms |
| p95 | 2.707 ms | 1.596 ms | 5.272 ms |
| p99 | 2.897 ms | 2.266 ms | 6.746 ms |
| Maximum | 8.333 ms | 37.008 ms | 28.632 ms |
| Real-time factor | 0.243 | 0.136 | 0.425 |

The integrated GPU is slower on average than this CPU for one stream, but its p95 is comfortably below the 10.667 ms hop and its observed maximum stayed below one hop. The GPU path therefore has scheduling headroom and moves the neural work off CPU. CPU remains a useful fallback and was faster on average in this test.

## Hardware and adapter proof

Windows reported these hardware adapters in DXGI/display order:

1. index 0: NVIDIA GeForce RTX 4070 SUPER, vendor `10DE`, device `2783`
2. index 1: AMD Radeon(TM) Graphics, vendor `1002`, device `164E`, driver `32.0.21045.5002`

The ONNX Runtime DirectML API defines `device_id` as the `IDXGIFactory::EnumAdapters` index ([DirectML EP documentation](https://github.com/microsoft/onnxruntime/blob/main/docs/execution_providers/DirectML-ExecutionProvider.md)). The probe passed `device_id=1`, rather than relying on the default adapter. Production discovery should enumerate DXGI, select the desired AMD LUID/vendor entry, retain its ordinal for the legacy DirectML API, and reject an unexpected adapter identity. ONNX Runtime's implementation calls `EnumAdapters1(device_id)` ([provider source](https://github.com/microsoft/onnxruntime/blob/main/onnxruntime/core/providers/dml/dml_provider_factory.cc)).

DirectML requires sequential execution and memory-pattern optimization disabled. The probe used both settings. The tested Python probe runtime was `onnxruntime-directml==1.23.0`; the production Rust runtime may be pinned separately, but it must reproduce the strict no-fallback readiness test on the selected adapter.

## Artifact pins

| File | Bytes | SHA-256 | Purpose |
|---|---:|---|---|
| upstream `denoiser_model.onnx` | 12,911,035 | `b758c49d6708a5b7979e3de185705a8a4915076c862fb17b1b304d9a72b75cdc` | Reproducible source graph |
| upstream `initial_states.npz` | 187,714 | `1165503707b8859a6b650b6bb0dc5b6c55d30c2779d87502f97a77102b5d3872` | Upstream state values |
| upstream `meta.json` | 1,112 | `f069011a01849629ad23fbb1d00f4417cf106d5e316e3f7fbcba65cce3440818` | Contract and source hashes |
| adjusted `denoiser_model_dml.onnx` | 12,912,242 | `41ab21252f5357d3ff29999ba37d7b529bcbbb60d3b7e2b8d720726185bb4740` | DirectML graph with standard convolutions |
| generated `initial_states.json` | 187,320 | `f430f056519c5b6ec2d949676cd2be29b62554f249f74683d681fefe6916c88c` | Rust-friendly exact float32 initial states |

The upstream release's three hashes matched after download. The adjustment and JSON state conversion are reproducible with `scripts/prepare-deepfilter-model.py`. The script downloads and verifies the pinned inputs, requires exactly 15 recognized `FusedConv` nodes, runs the full ONNX checker, verifies both output-file hashes, and requires bit-identical deterministic CPU inference against the source graph. Probe code, raw results, ONNX Runtime profiles, DXDiag inventory and artifacts live under `.local/amd-probe/` and are intentionally excluded from source control.

## Streaming contract

The graph is ONNX IR 8, opset 17, mono float32 at 48 kHz. Each call consumes `input_frame: [512]` and returns `enhanced_audio_frame: [512]`. The 512-sample hop is 10.667 ms.

The other 12 float32 inputs are persistent state. Each output in the same row becomes the next invocation's input:

| Input | Shape | Output |
|---|---|---|
| `erb_norm_state` | `[32]` | `new_erb_norm_state` |
| `band_unit_norm_state` | `[1,96,1]` | `new_band_unit_norm_state` |
| `analysis_mem` | `[512]` | `new_analysis_mem` |
| `synthesis_mem` | `[512]` | `new_synthesis_mem` |
| `rolling_erb_buf` | `[1,1,3,32]` | `new_rolling_erb_buf` |
| `rolling_feat_spec_buf` | `[1,2,3,96]` | `new_rolling_feat_spec_buf` |
| `rolling_c0_buf` | `[1,64,5,96]` | `new_rolling_c0_buf` |
| `rolling_spec_buf_x` | `[5,513,2]` | `new_rolling_spec_buf_x` |
| `rolling_spec_buf_y` | `[7,513,2]` | `new_rolling_spec_buf_y` |
| `enc_hidden` | `[1,1,256]` | `new_enc_hidden` |
| `erb_dec_hidden` | `[2,1,256]` | `new_erb_dec_hidden` |
| `df_dec_hidden` | `[2,1,256]` | `new_df_dec_hidden` |

The adjusted graph's standard operator inventory is: Add 12, Concat 9, Conv 22, ConvTranspose 2, DFT 1, Div 3, Einsum 1, GRU 5, Gather 1, Identity 1, Log 1, MatMul 10, Mul 14, Pow 1, ReduceL2 1, ReduceSum 2, Relu 20, Reshape 18, ScatterND 1, Sigmoid 1, Slice 11, Split 3, Sqrt 1, Squeeze 11, Sub 2, Tanh 1, Transpose 8 and Unsqueeze 7.

An impulse injected at sample 2,560 produced the largest output response at sample 4,097: an observed impulse-response peak lag of 1,537 samples, or 32.02 ms. The graph's exact framing delay is three hops (1,536 samples, 32 ms); the extra sample locates the peak of the STFT/iSTFT impulse response. An attenuation-limit dry/wet blend must delay the dry signal by exactly 1,536 samples. Device capture, bridge and playback buffering add to this delay.

The upstream two-second noisy-speech fixture was also processed through the adjusted graph on the AMD adapter with CPU fallback disabled. AMD output differed from CPU by at most `8.05e-7` (`8.02e-8` RMS), and from the upstream PCM16 reference by at most `3.10e-5` (`1.76e-5` RMS, within one PCM16 quantization step). Overall RMS fell 3.08 dB. The quietest input-frame quartile fell 8.77 dB while the loudest quartile fell 1.37 dB, evidence that the stateful graph attenuates low-level noisy regions much more strongly while retaining substantially more active speech energy. This is a signal-level sanity check rather than a perceptual quality score. Fixture hashes are `15402301438009db8f5b6159e3bc5bc656dde4a5fd739d4a31a8837333f6ff24` for `noisy_2s_48k.wav` and `6ab436889d3ff9a7b9a124bfa63b6b46202c3a294c6d21ee97342128011f8880` for `reference_2s_48k.wav`; both come from the pinned MIT-licensed `deepfilter-stream` repository.

## Readiness gate and remaining acceptance

A production readiness probe should load the adjusted graph on the specifically selected AMD adapter, enable the equivalent of `session.disable_cpu_ep_fallback=1`, run several nonzero frames through all state outputs, reject NaN/shape errors, and require a bounded response. Provider registration alone does not prove GPU execution.

This establishes runtime feasibility and synthetic timing only. It does not establish physical microphone quality, echo behavior, device-loss cleanup, contention while gaming, long-session thermal behavior, or quality parity against native DeepFilterNet. Those remain integration acceptance checks. No Adrenalin-side noise-removal application or virtual microphone is required by this path.
