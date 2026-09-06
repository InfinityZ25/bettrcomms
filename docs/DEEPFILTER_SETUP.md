# DeepFilterNet DirectML setup

Bettercomms can install an optional, application-private DeepFilterNet runtime for Windows x64. It uses DirectML through ONNX Runtime and does not require Python, a virtual microphone, a separate audio application, driver changes, or a global `PATH` entry.

Setup is explicit. Reading `deepfilter_install_info` never installs or downloads anything. `deepfilter_install` accepts no URL or filesystem path and publishes only to `%LOCALAPPDATA%\Bettercomms\deepfilter-directml`. The command downloads 215,038,684 bytes: the official Microsoft ONNX Runtime DirectML 1.23.0 NuGet package and its pinned Microsoft DirectML 1.15.4 dependency. It enforces exact byte counts, SHA-256 hashes, per-file and total caps, and a ten-minute download timeout. Extraction copies only named Windows x64 entries. A same-parent staging directory is moved into place only after every required runtime, model, manifest, and notice file exists; errors clean the staging directory and preserve an existing installation.

The denoiser graph and state are compiled into the native application. The graph is derived from the DeepFilterNet3 `torchDF` streaming export in `deepfilter-stream` commit `be1a989760c93f3107c0c39a6d866df8d6bd40b2`, release `model-dfn3-512-v1`, whose upstream graph SHA-256 is `b758c49d6708a5b7979e3de185705a8a4915076c862fb17b1b304d9a72b75cdc`. The bundled graph applies a lossless convolution-layout rewrite for strict DirectML execution and has SHA-256 `41ab21252f5357d3ff29999ba37d7b529bcbbb60d3b7e2b8d720726185bb4740`. It processes mono 48 kHz audio in 512-sample frames and carries twelve float32 recurrent state tensors between frames. `initial_states.json` is a product runtime representation of the release's `initial_states.npz`; it has SHA-256 `f430f056519c5b6ec2d949676cd2be29b62554f249f74683d681fefe6916c88c`.

The installed layout is:

- `setup.json` — schema version 1, pinned versions, paths, frame format, and artifact hashes
- `runtime/onnxruntime.dll`
- `runtime/onnxruntime_providers_shared.dll`
- `runtime/DirectML.dll`
- `models/denoiser_model.onnx`
- `models/initial_states.json`
- `models/meta.json` — upstream model metadata; `setup.json` records the DirectML rewrite provenance
- `notices/onnxruntime-LICENSE`
- `notices/onnxruntime-ThirdPartyNotices.txt`
- `notices/directml-LICENSE.txt`
- `notices/directml-LICENSE-CODE.txt`
- `notices/directml-ThirdPartyNotices.txt`
- `notices/deepfilter-stream-LICENSE`
- `notices/deepfilter-stream-NOTICE`
- `notices/DeepFilterNet-LICENSE`, `DeepFilterNet-LICENSE-APACHE`, and `DeepFilterNet-LICENSE-MIT`
- `notices/Bettercomms-MODEL-NOTICE.txt` — the 15 lossless FusedConv-to-Conv conversions and adapted graph hash

ONNX Runtime is pinned to Microsoft release commit `0b2c4ac474a32ed700fd75435fb180ddfbbb4af6`. DeepFilterNet source provenance is upstream commit `978576aa8400552a4ce9730838c635aa30db5e61`. Preserve every installed notice and confirm distribution obligations before a public release.

Installation only establishes that trusted files are present. The native readiness command must load the private `onnxruntime.dll`, request DirectML with CPU fallback disabled, select the intended adapter, initialize the graph and all state tensors, and process a finite 512-sample frame before the UI reports DeepFilterNet as ready. Browser processing remains available when this optional path is absent or fails.
