[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.IO.Compression.FileSystem
$url = 'https://github.com/GyanD/codexffmpeg/releases/download/8.1/ffmpeg-8.1-full_build.zip'
$archiveBytes = 247913948L
$archiveHash = '587B1C37DE29C5003D01CF65DA10001BAC43A58B88E61AF0FC77C61DAFF04761'
$ffmpegBytes = 223360000L
$ffmpegHash = 'D1E2A156261ECC675081943197A85F08F2868784A0AF499171EDE89353EDAD31'
$licenseBytes = 35147L
$licenseHash = '8CEB4B9EE5ADEDDE47B31E975C1D90C73AD27B6B165A1DCD80C7C545EB65B903'
function Full([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar) }
function Assert-File([string]$Path, [long]$Bytes, [string]$Hash) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Item -LiteralPath $Path).Length -ne $Bytes -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Hash) { throw "Runtime file failed its pinned length or SHA-256 check: $([IO.Path]::GetFileName($Path))" }
}
function Copy-Entry($Archive, [string]$Name, [string]$Output, [long]$MaximumBytes) {
    $entry = $Archive.GetEntry($Name)
    if ($null -eq $entry -or $entry.Length -gt $MaximumBytes) { throw "Pinned archive entry is missing or too large: $Name" }
    $input = $entry.Open(); $outputStream = [IO.File]::Create($Output)
    try { $input.CopyTo($outputStream) } finally { $outputStream.Dispose(); $input.Dispose() }
}
$destinationFull = Full $Destination
$workingFull = Full $WorkingDirectory
$parent = Full (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Bettercomms')
if ((Full ([IO.Path]::GetDirectoryName($destinationFull))) -ne $parent -or [IO.Path]::GetFileName($destinationFull) -ne 'ffmpeg-8.1') { throw 'Destination is outside the Bettercomms application data directory' }
if ((Full ([IO.Path]::GetDirectoryName($workingFull))) -ne $parent -or [IO.Path]::GetFileName($workingFull) -notlike 'ffmpeg-install-*') { throw 'Working directory is outside the Bettercomms application data directory' }
[IO.Directory]::CreateDirectory($parent) | Out-Null
foreach ($path in @($parent, $destinationFull)) {
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'FFmpeg setup directories cannot be reparse points' }
}
[IO.Directory]::CreateDirectory($workingFull) | Out-Null
$archivePath = Join-Path $workingFull 'ffmpeg.zip'
$prepared = Join-Path $workingFull 'prepared'
[IO.Directory]::CreateDirectory($prepared) | Out-Null
try {
    $handler = [Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect = $true
    $client = [Net.Http.HttpClient]::new($handler); $client.Timeout = [TimeSpan]::FromMinutes(12)
    try {
        $response = $client.GetAsync($url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        [void]$response.EnsureSuccessStatusCode()
        if ($null -ne $response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -ne $archiveBytes) { throw 'Pinned FFmpeg download length changed' }
        $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult(); $output = [IO.File]::Create($archivePath)
        $buffer = New-Object byte[] 1048576; $received = 0L
        try { while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) { $received += $read; if ($received -gt $archiveBytes) { throw 'FFmpeg download exceeded its pinned size' }; $output.Write($buffer, 0, $read) } } finally { $output.Dispose(); $input.Dispose() }
    } finally { $client.Dispose(); $handler.Dispose() }
    Assert-File $archivePath $archiveBytes $archiveHash
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        Copy-Entry $zip 'ffmpeg-8.1-full_build/bin/ffmpeg.exe' (Join-Path $prepared 'ffmpeg.exe') 224000000L
        Copy-Entry $zip 'ffmpeg-8.1-full_build/LICENSE' (Join-Path $prepared 'LICENSE') 100000L
    } finally { $zip.Dispose() }
    Assert-File (Join-Path $prepared 'ffmpeg.exe') $ffmpegBytes $ffmpegHash
    Assert-File (Join-Path $prepared 'LICENSE') $licenseBytes $licenseHash
    $probe = & (Join-Path $prepared 'ffmpeg.exe') -hide_banner -filters 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $probe -notmatch '\bgfxcapture\b') { throw 'Pinned FFmpeg runtime does not provide Windows Graphics Capture' }
    [IO.File]::WriteAllText((Join-Path $prepared 'setup.json'), (@{schemaVersion=1; version='8.1'; archiveSha256=$archiveHash; ffmpegSha256=$ffmpegHash; source=$url} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $backup = "$destinationFull.backup-$([Guid]::NewGuid().ToString('N'))"
    if (Test-Path -LiteralPath $destinationFull) { Move-Item -LiteralPath $destinationFull -Destination $backup }
    try {
        Move-Item -LiteralPath $prepared -Destination $destinationFull
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    } catch {
        if (Test-Path -LiteralPath $destinationFull) { Remove-Item -LiteralPath $destinationFull -Recurse -Force }
        if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $destinationFull }
        throw
    }
} finally {
    if (Test-Path -LiteralPath $workingFull) { Remove-Item -LiteralPath $workingFull -Recurse -Force }
}
