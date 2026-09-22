# Package the already-built Windows host. Building first avoids distributing
# stale embedded assets; -SkipBuild is for CI after its full validated build.
[CmdletBinding()]
param(
    [string]$ApiOrigin,
    [string]$MakeNSIS = 'makensis.exe',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'apps/desktop-wails'
if ($SkipBuild -and $ApiOrigin) { throw 'ApiOrigin requires a new build; do not combine it with SkipBuild.' }
$compiler = Get-Command $MakeNSIS -CommandType Application -ErrorAction Stop
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build-desktop-wails.ps1') -ApiOrigin $ApiOrigin
}
& (Join-Path $PSScriptRoot 'stage-wails-ffmpeg.ps1')
$bundle = Join-Path $app 'bin'
$binary = Join-Path $bundle 'bettercomms-wails.exe'
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Build the Wails executable first.' }
$metadata = & $binary --print-build-info
if ($LASTEXITCODE -ne 0) { throw 'The packaged executable metadata check failed.' }
$version = (Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Installer version must be a three-part numeric version.' }
if (($metadata | ConvertFrom-Json).version -ne "$version-wails") { throw 'Package and executable versions disagree.' }
$output = Join-Path $bundle "bettercomms-wails-$version-windows-x64-setup.exe"
Push-Location (Join-Path $app 'build/windows')
try {
    & $compiler.Source /V3 "/DBUNDLE_DIR=$bundle" "/DOUTPUT_FILE=$output" "/DPRODUCT_VERSION=$version" installer.nsi
    if ($LASTEXITCODE -ne 0) { throw 'NSIS packaging failed.' }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'NSIS did not produce the expected installer.' }
Write-Host "Installer: $output"
Write-Host 'Unsigned preview. Requires WebView2 Evergreen; native install/upgrade/uninstall acceptance remains a release gate.'
