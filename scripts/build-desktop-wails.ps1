# Production build for the Wails v3 host.
#
# Builds the shared frontend, stages it for embedding, then builds the Go
# binary. `wails3 build` is used when the pinned CLI is present, because it also
# applies platform metadata and icons; otherwise this falls back to `go build`,
# which produces a working, unbranded executable.

[CmdletBinding()]
param(
    # The API origin baked into this build's boot report. Production requires
    # HTTPS with no path, query, fragment, or credentials.
    [string]$ApiOrigin,
    # Path to the pinned Wails CLI.
    [string]$Wails3 = "$env:USERPROFILE\go\bin\wails3.exe"
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'apps/desktop-wails'

if (-not (Test-Path $Wails3)) {
    throw "wails3 v3.0.0-beta.18 is required at $Wails3 to generate bindings and build the host."
}

Write-Host '== Generating Wails service bindings =='
Push-Location $app
try {
    & $Wails3 generate bindings -ts -clean -d ../web/src/desktop/wailsbindings .
    if ($LASTEXITCODE -ne 0) { throw 'wails3 binding generation failed.' }
} finally {
    Pop-Location
}

Write-Host '== Building the shared frontend =='
npm --prefix (Join-Path $repo 'apps/web') run build
if ($LASTEXITCODE -ne 0) { throw 'The frontend build failed.' }

Write-Host '== Staging apps/web/dist for embedding =='
& (Join-Path $PSScriptRoot 'stage-wails-frontend.ps1')

if ($ApiOrigin) {
    $env:BETTERCOMMS_API_ORIGIN = $ApiOrigin
}

try {
    Push-Location $app
    if (-not (Test-Path (Join-Path $app 'go.sum'))) {
        Write-Host '== Resolving Go dependencies =='
        go mod tidy
        if ($LASTEXITCODE -ne 0) { throw 'go mod tidy failed.' }
    }

    Write-Host '== Checking the host =='
    go vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'go vet failed.' }
    go test ./...
    if ($LASTEXITCODE -ne 0) { throw 'go test failed.' }

    Write-Host "== Building with $Wails3 =="
    & $Wails3 build
    if ($LASTEXITCODE -ne 0) { throw 'wails3 build failed.' }
} finally {
    Pop-Location
}

Write-Host 'Done. This build has no native capture, native audio processing, or native recording; see apps/desktop-wails/README.md.'
