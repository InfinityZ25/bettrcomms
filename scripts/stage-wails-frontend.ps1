# Copies the built shared frontend into the Wails host's embed directory.
#
# apps/web stays the single frontend source. This stages its build output so
# `//go:embed all:frontend/dist` has something to embed; nothing is forked.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'apps/web/dist'
$target = Join-Path $repo 'apps/desktop-wails/frontend/dist'

if (-not (Test-Path (Join-Path $source 'index.html'))) {
    throw "apps/web is not built. Run 'npm run build' at the repository root first."
}

# Replace the staged copy rather than merging into it, so a file deleted from a
# frontend build cannot survive in the packaged binary.
$keep = Join-Path $target '.gitkeep'
$keepContent = if (Test-Path $keep) { Get-Content -Raw $keep } else { $null }

if (Test-Path $target) {
    Remove-Item -Recurse -Force $target
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force

if ($null -ne $keepContent) {
    Set-Content -Path $keep -Value $keepContent -NoNewline
}

$count = (Get-ChildItem -Recurse -File $target | Measure-Object).Count
Write-Host "Staged $count files from apps/web/dist into apps/desktop-wails/frontend/dist"
