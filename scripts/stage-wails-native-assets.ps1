[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repo 'apps/desktop-wails/internal/native/dspsetup/assets'
[void](New-Item -ItemType Directory -Force -Path $target)
foreach ($name in @('install-deepfilter.ps1', 'install-nvidia-audio.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $target $name)
}
$modelTarget = Join-Path $target 'deepfilter'
foreach ($name in @('denoiser_model.onnx', 'initial_states.json', 'meta.json', 'deepfilter-stream-LICENSE', 'deepfilter-stream-NOTICE', 'DeepFilterNet-LICENSE', 'DeepFilterNet-LICENSE-APACHE', 'DeepFilterNet-LICENSE-MIT')) {
    if (-not (Test-Path -LiteralPath (Join-Path $modelTarget $name) -PathType Leaf)) {
        throw "Wails model asset is missing: $name"
    }
}
