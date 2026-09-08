[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$destination = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'apps/desktop/src-tauri/generated/ffmpeg/windows-x64'))
$generatedRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'apps/desktop/src-tauri/generated'))
if (-not $destination.StartsWith($generatedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'FFmpeg bundle destination escaped the generated resource directory'
}

$ffmpegBytes = 223360000L
$ffmpegHash = 'D1E2A156261ECC675081943197A85F08F2868784A0AF499171EDE89353EDAD31'
$licenseBytes = 35147L
$licenseHash = '8CEB4B9EE5ADEDDE47B31E975C1D90C73AD27B6B165A1DCD80C7C545EB65B903'
function Assert-File([string]$Path, [long]$Bytes, [string]$Hash) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Get-Item -LiteralPath $Path).Length -ne $Bytes -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Hash) {
        throw "Runtime file failed its pinned length or SHA-256 check: $([IO.Path]::GetFileName($Path))"
    }
}

$privateRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Bettercomms/ffmpeg-8.1'
$privateFfmpeg = Join-Path $privateRoot 'ffmpeg.exe'
$privateLicense = Join-Path $privateRoot 'LICENSE'
try {
    Assert-File $privateFfmpeg $ffmpegBytes $ffmpegHash
    Assert-File $privateLicense $licenseBytes $licenseHash
    if (-not (Test-Path -LiteralPath (Join-Path $privateRoot 'setup.json') -PathType Leaf)) {
        throw 'Runtime setup metadata is missing'
    }
} catch {
    $work = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Bettercomms/ffmpeg-install-$([Guid]::NewGuid().ToString('N'))"
    & (Join-Path $scriptRoot 'install-ffmpeg-runtime.ps1') -Destination $privateRoot -WorkingDirectory $work
    Assert-File $privateFfmpeg $ffmpegBytes $ffmpegHash
    Assert-File $privateLicense $licenseBytes $licenseHash
}

if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
}
[IO.Directory]::CreateDirectory($destination) | Out-Null
Copy-Item -LiteralPath $privateFfmpeg -Destination (Join-Path $destination 'ffmpeg.exe')
Copy-Item -LiteralPath $privateLicense -Destination (Join-Path $destination 'LICENSE')
Copy-Item -LiteralPath (Join-Path $privateRoot 'setup.json') -Destination (Join-Path $destination 'setup.json')
[IO.File]::WriteAllText(
    (Join-Path $destination 'SOURCE.txt'),
    "BetterComms bundles FFmpeg 8.1 from Gyan Doshi's official Windows build.`r`nBinary package: https://github.com/GyanD/codexffmpeg/releases/tag/8.1`r`nFFmpeg corresponding source: https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n8.1.tar.gz`r`nBuild scripts: https://github.com/GyanD/codexffmpeg/tree/8.1`r`n",
    [Text.UTF8Encoding]::new($false)
)
Assert-File (Join-Path $destination 'ffmpeg.exe') $ffmpegBytes $ffmpegHash
Assert-File (Join-Path $destination 'LICENSE') $licenseBytes $licenseHash
Write-Host "Prepared verified FFmpeg bundle resource at $destination"
