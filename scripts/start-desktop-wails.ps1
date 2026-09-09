# Development runner for the Wails v3 host.
#
# It starts the shared Vite server if it is not already running, then runs the
# Go host against it. The host proxies the dev server, so frontend edits reload
# without rebuilding Go.
#
# The Go API is started separately:  ./scripts/start-api.ps1 -DevAuth
#
# This does not touch apps/desktop. Both desktop hosts can be built from the
# same checkout, but do not run them at the same time against one dev server if
# you want a readable log.

[CmdletBinding()]
param(
    # Skips starting Vite, for when it is already running in another terminal.
    [switch]$NoFrontend,
    # Overrides the API origin the host validates and reports to the page.
    [string]$ApiOrigin
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'apps/desktop-wails'
$devServer = 'http://localhost:5173'
# Vite deliberately binds to IPv4 (see apps/web/package.json). Keep the public
# localhost URL for auth/callback compatibility, but probe the address that is
# actually listening. On some Windows machines localhost resolves to ::1 first
# and Invoke-WebRequest then waits even though Vite is already ready on IPv4.
$devServerProbe = 'http://127.0.0.1:5173'

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw 'Go is not on PATH. Install Go 1.25 or newer.'
}

# On Windows npm is a command shim (`npm.cmd`), not a native executable.
# Start-Process does not reliably resolve the extension-less `npm` command,
# so pass the shim's absolute path just like the existing Tauri launcher does.
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    throw 'npm.cmd is unavailable. Install Node.js/npm or add it to PATH.'
}

function Test-DevServer {
    try {
        Invoke-WebRequest -Uri $devServerProbe -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Stop-StartedProcessTree {
    param([System.Diagnostics.Process]$Process)

    if (-not $Process -or $Process.HasExited) {
        return
    }

    # npm.cmd starts Vite as a child Node process. Stopping only the command
    # shim can orphan that child and leave port 5173 occupied for the next run.
    & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
}

$vite = $null
try {
    if (-not $NoFrontend -and -not (Test-DevServer)) {
        Write-Host 'Starting the shared Vite server on 5173...'
        $startupWatch = [System.Diagnostics.Stopwatch]::StartNew()
        $vite = Start-Process -PassThru -WindowStyle Hidden -FilePath $npm.Source -ArgumentList 'run', 'dev' -WorkingDirectory $repo
        $startupTimeoutSeconds = 30
        $deadline = (Get-Date).AddSeconds($startupTimeoutSeconds)
        while (-not (Test-DevServer)) {
            if ($vite.HasExited) {
                throw "The Vite process exited before opening port 5173 (exit code $($vite.ExitCode))."
            }
            if ((Get-Date) -gt $deadline) {
                throw "The Vite server did not start within $startupTimeoutSeconds seconds. Try 'npm run dev -w apps/web' to see its startup error."
            }
            Start-Sleep -Milliseconds 500
        }
        $startupWatch.Stop()
        Write-Host "Vite is ready ($($startupWatch.ElapsedMilliseconds) ms)."
    }

    $env:BETTERCOMMS_DEV_SERVER = $devServer
    if ($ApiOrigin) {
        $env:BETTERCOMMS_API_ORIGIN = $ApiOrigin
    }

    Push-Location $app
    try {
        # go.sum is produced by `go mod tidy`, which needs network access once.
        if (-not (Test-Path (Join-Path $app 'go.sum'))) {
            Write-Host 'Resolving Go dependencies (first run)...'
            go mod tidy
        }
        go run .
    } finally {
        Pop-Location
    }
} finally {
    if ($vite -and -not $vite.HasExited) {
        Write-Host 'Stopping the Vite server this script started...'
        Stop-StartedProcessTree $vite
    }
}
