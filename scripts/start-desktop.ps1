[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$desktopRoot = Join-Path $projectRoot 'apps\desktop'
$tauriTarget = [IO.Path]::GetFullPath((Join-Path $desktopRoot 'src-tauri\target'))

# A directly launched target executable has no source watcher and continues to
# serve the live Vite frontend with the command table compiled into that process.
# Refuse to hide one underneath a second window or development host.
$existing = Get-CimInstance Win32_Process -Filter "Name = 'bettercomms-desktop.exe'" |
    Where-Object {
        $_.ExecutablePath -and
        [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
            $tauriTarget + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )
    } |
    Select-Object -First 1
if ($existing) {
    throw "Bettercomms desktop is already running from this workspace (PID $($existing.ProcessId)). Close that window normally, then run this launcher again so the native command table is rebuilt."
}

$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) {
    $pathEntries = $env:PATH -split ';'
    if ($cargoBin -notin $pathEntries) {
        $env:PATH = "$cargoBin;$env:PATH"
    }
}
if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
    throw 'cargo.exe is unavailable. Install the repository Rust toolchain or add its bin directory to PATH.'
}
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    throw 'npm.cmd is unavailable. Install the repository Node.js toolchain or add it to PATH.'
}

Push-Location $desktopRoot
try {
    $viteListener = Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($viteListener) {
        $viteProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($viteListener.OwningProcess)"
        if (-not ($viteProcess.CommandLine -like "*$projectRoot*" -and $viteProcess.CommandLine -like '*vite*')) {
            throw 'Port 5173 is occupied by a different application. Close it before starting the desktop preview.'
        }
        $localRoot = Join-Path $projectRoot '.local'
        New-Item -ItemType Directory -Force -Path $localRoot | Out-Null
        $overridePath = Join-Path $localRoot 'desktop-existing-vite.json'
        '{"build":{"beforeDevCommand":""}}' | Set-Content -LiteralPath $overridePath -Encoding utf8
        & $npm.Source run dev -- --config $overridePath
    } else {
        & $npm.Source run dev
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri development launcher exited with code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
