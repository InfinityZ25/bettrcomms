# DeepFilterNet WebGPU research probe

Status: blocked on ONNX Runtime Web 1.29.0; do not expose this engine in the product.

Generate the pinned research graph with the repository's probe Python environment:

```powershell
& .local/amd-probe/python/python.exe scripts/prepare-deepfilter-webgpu.py `
  apps/desktop/src-tauri/resources/deepfilter/denoiser_model.onnx `
  .local/amd-probe/model/denoiser_model_webgpu.onnx
```

The script validates the source SHA-256, expands all five fixed single-step
forward GRUs with `linear_before_reset=1`, canonicalizes negative axes and
static reshape dimensions, runs the full ONNX checker, and validates the
deterministic output SHA-256. The generated graph is 12,927,005 bytes with
SHA-256 `4da0d5c1c79bac9fa32b4b747658a2b34ae1166060277ea8cfa7ab9833d952b2`.

CPU validation used ONNX Runtime 1.23.0 and 100 deterministic stateful frames.
Every recurrent output was fed into the next invocation. The maximum absolute
difference from the pinned source graph was `2.1457672119140625e-06`; all
outputs were finite.

The hardware attempt used Google Chrome with D3D11, a high-performance WebGPU
adapter requested with `forceFallbackAdapter:false`, and rejected adapters
whose `GPUAdapterInfo.isFallbackAdapter` was not exactly `false` or whose info
identified SwiftShader/software/llvmpipe. ONNX Runtime Web was pinned to
1.29.0 and configured with only `executionProviders:['webgpu']` and
`enableGraphCapture:true`. All thirteen inputs and outputs used fixed external
WebGPU storage buffers (`STORAGE | COPY_SRC | COPY_DST`); the twelve recurrent
outputs were copied GPU-to-GPU into fixed input buffers between frames. Only
the 512-sample input upload and enhanced-audio readback crossed the CPU/GPU
boundary.

The probe requested strict graph capture with the fixed external buffer
contract to prevent a silently partitioned WASM model path. No complete GPU
inference succeeded; the first attempt failed consistently in ORT with:

```text
Invalid dimension of 4294967295 for SizeToDimension. Tensor has 1 dimensions.
```

The same failure remained after converting every negative axis attribute,
axes tensor, and inferred reshape dimension to its positive static value. The
current artifact therefore has no real-time result and must not be called GPU
ready. A future retry should pin the ORT Web version, retain graph capture and
external GPU buffers as hard gates, identify/fix the failing WebGPU kernel,
compare at least 100 stateful frames with the CPU reference, and require p95
below 8 ms to leave scheduling headroom within the 10.667 ms audio hop.

Model provenance is `deepfilter-stream` commit
`be1a989760c93f3107c0c39a6d866df8d6bd40b2`, model release
`model-dfn3-512-v1`, derived from DeepFilterNet tag v0.5.6. Preserve the
DeepFilterNet and deepfilter-stream license/notice files beside any future
browser model distribution.
