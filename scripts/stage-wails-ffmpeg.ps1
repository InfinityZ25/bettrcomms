[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
# Wails invokes Windows PowerShell, which may inherit PowerShell 7's module
# path. Restore its own standard modules before using verification/install tools.
$systemModules = Join-Path $PSHOME 'Modules'
if (($env:PSModulePath -split ';') -notcontains $systemModules) {
    $env:PSModulePath = $systemModules + ';' + $env:PSModulePath
}
Import-Module (Join-Path $systemModules 'Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -Force -ErrorAction Stop
$repo = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $repo 'apps/desktop-wails/bin/ffmpeg'
$pins = @{
    'ffmpeg.exe' = @(223360000L, 'D1E2A156261ECC675081943197A85F08F2868784A0AF499171EDE89353EDAD31')
    'LICENSE' = @(35147L, '8CEB4B9EE5ADEDDE47B31E975C1D90C73AD27B6B165A1DCD80C7C545EB65B903')
}
function Assert-Runtime([string]$Root) {
    foreach ($name in $pins.Keys) {
        $path = Join-Path $Root $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-Item -LiteralPath $path).Length -ne $pins[$name][0] -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $pins[$name][1]) {
            throw "Bundled runtime failed verification: $name"
        }
    }
    foreach ($name in @('setup.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $name) -PathType Leaf)) {
            throw "Bundled runtime is missing $name"
        }
    }
}

$privateRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Bettercomms/ffmpeg-8.1'
try { Assert-Runtime $privateRoot } catch {
    $work = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Bettercomms/ffmpeg-install-$([Guid]::NewGuid().ToString('N'))"
    & (Join-Path $PSScriptRoot 'install-ffmpeg-runtime.ps1') -Destination $privateRoot -WorkingDirectory $work
    Assert-Runtime $privateRoot
}
[void](New-Item -ItemType Directory -Force -Path $destination)
foreach ($name in @('ffmpeg.exe', 'LICENSE', 'setup.json')) {
    Copy-Item -LiteralPath (Join-Path $privateRoot $name) -Destination (Join-Path $destination $name) -Force
}
[IO.File]::WriteAllText(
    (Join-Path $destination 'SOURCE.txt'),
    "BetterComms bundles FFmpeg 8.1 from Gyan Doshi's official Windows build.`r`nBinary package: https://github.com/GyanD/codexffmpeg/releases/tag/8.1`r`nFFmpeg corresponding source: https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n8.1.tar.gz`r`nBuild scripts: https://github.com/GyanD/codexffmpeg/tree/8.1`r`n",
    [Text.UTF8Encoding]::new($false)
)
Assert-Runtime $destination
Write-Host 'Verified FFmpeg runtime and notices staged beside the Wails executable.'
