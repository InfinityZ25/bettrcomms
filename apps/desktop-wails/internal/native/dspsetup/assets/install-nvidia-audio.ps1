[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Net.Http

$sdkUrl = 'https://international.download.nvidia.com/Windows/broadcast/sdk/AFX/2025-01-21_NVIDIA_AFX_SDK_Win_v1.6.1.2-GA_Ada.exe'
$sdkSha256 = '7121F7C494318804812C61F60D93BAC2F7BF723C616359B37A6D6F25AB752002'
$sdkBytes = 706540584L
$sevenZipUrl = 'https://www.7-zip.org/a/7zr.exe'
$sevenZipSha256 = 'AD4C82FADCBDF93C03B4FC440F300509C7D60C5C2F4D183E35D9D70D6957037D'
$maximumDownloadBytes = 750000000L

function Get-FullPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Receive-PinnedFile([string]$Url, [string]$Output, [long]$ExpectedBytes, [string]$ExpectedHash) {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(30)
    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $response.EnsureSuccessStatusCode()
        $length = $response.Content.Headers.ContentLength
        if ($null -ne $length -and ($length -ne $ExpectedBytes -or $length -gt $maximumDownloadBytes)) {
            throw "Unexpected download size: $length bytes"
        }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [System.IO.File]::Create($Output)
        $buffer = New-Object byte[] 1048576
        $received = 0L
        $deadline = [DateTime]::UtcNow.AddMinutes(30)
        try {
            while ($true) {
                $remaining = $deadline - [DateTime]::UtcNow
                if ($remaining -le [TimeSpan]::Zero) { throw 'Download timed out' }
                $cancel = [Threading.CancellationTokenSource]::new($remaining)
                try {
                    $read = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token).GetAwaiter().GetResult()
                } finally { $cancel.Dispose() }
                if ($read -eq 0) { break }
                $received += $read
                if ($received -gt $ExpectedBytes -or $received -gt $maximumDownloadBytes) {
                    throw 'Download exceeded its pinned size'
                }
                $outputStream.Write($buffer, 0, $read)
            }
        } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }
    $actualBytes = (Get-Item -LiteralPath $Output).Length
    if ($actualBytes -ne $ExpectedBytes -or $actualBytes -gt $maximumDownloadBytes) {
        throw "Downloaded file has unexpected size: $actualBytes bytes"
    }
    $actualHash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash
    if ($actualHash -ne $ExpectedHash) { throw "Downloaded file failed SHA-256 verification" }
}

$destinationFull = Get-FullPath $Destination
$workingFull = Get-FullPath $WorkingDirectory
$expectedParent = Get-FullPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Bettercomms')
if ((Get-FullPath ([System.IO.Path]::GetDirectoryName($destinationFull))) -ne $expectedParent -or
    [System.IO.Path]::GetFileName($destinationFull) -ne 'nvidia-audio-effects') {
    throw 'Destination is outside the Bettercomms application data directory'
}
if ((Get-FullPath ([System.IO.Path]::GetDirectoryName($workingFull))) -ne $expectedParent -or
    [System.IO.Path]::GetFileName($workingFull) -notlike 'nvidia-install-*' -or
    $workingFull -eq $destinationFull) {
    throw 'Working directory is outside the Bettercomms application data directory'
}

New-Item -ItemType Directory -Force -Path $expectedParent | Out-Null
if ((Get-Item -LiteralPath $expectedParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Bettercomms application data directory cannot be a reparse point'
}
if ((Test-Path -LiteralPath $destinationFull) -and
    ((Get-Item -LiteralPath $destinationFull -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'NVIDIA destination cannot be a reparse point'
}
New-Item -ItemType Directory -Force -Path $workingFull | Out-Null
if ((Get-Item -LiteralPath $workingFull -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'NVIDIA working directory cannot be a reparse point'
}
$installer = Join-Path $workingFull 'afx-ada.exe'
$sevenZip = Join-Path $workingFull '7zr.exe'
$extract = Join-Path $workingFull 'extract'
$prepared = Join-Path $workingFull 'prepared'

try {
    Receive-PinnedFile $sdkUrl $installer $sdkBytes $sdkSha256
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'NVIDIA CORPORATION') {
        throw 'NVIDIA installer Authenticode signature is not valid'
    }
    Receive-PinnedFile $sevenZipUrl $sevenZip 602624L $sevenZipSha256

    New-Item -ItemType Directory -Force -Path $extract, $prepared | Out-Null
    $extractStart = [Diagnostics.ProcessStartInfo]::new()
    $extractStart.FileName = $sevenZip
    $extractStart.UseShellExecute = $false
    $extractStart.CreateNoWindow = $true
    $extractStart.RedirectStandardOutput = $true
    $extractStart.RedirectStandardError = $true
    $quotedInstaller = '"' + $installer.Replace('"', '\"') + '"'
    $quotedOutput = '"-o' + $extract.Replace('"', '\"') + '"'
    $extractStart.Arguments = 'x ' + $quotedInstaller + ' ' + $quotedOutput + ' -y'
    $extractProcess = [Diagnostics.Process]::new()
    $extractProcess.StartInfo = $extractStart
    if (-not $extractProcess.Start()) { throw 'Could not start 7-Zip extraction' }
    $stdoutRead = $extractProcess.StandardOutput.ReadToEndAsync()
    $stderrRead = $extractProcess.StandardError.ReadToEndAsync()
    if (-not $extractProcess.WaitForExit(300000)) {
        $extractProcess.Kill()
        throw '7-Zip extraction timed out'
    }
    $extractStdout = $stdoutRead.GetAwaiter().GetResult()
    $extractStderr = $stderrRead.GetAwaiter().GetResult()
    if ($extractProcess.ExitCode -ne 0) {
        throw "7-Zip extraction failed with exit code $($extractProcess.ExitCode): $($extractStderr.Trim())"
    }

    $sdkRoot = Get-ChildItem -LiteralPath $extract -Directory -Recurse |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\NVAudioEffects.dll') } |
        Select-Object -First 1
    if ($null -eq $sdkRoot) { throw 'Extracted package does not contain NVAudioEffects.dll' }

    $runtime = New-Item -ItemType Directory -Force -Path (Join-Path $prepared 'runtime')
    $models = New-Item -ItemType Directory -Force -Path (Join-Path $prepared 'models')
    $notices = New-Item -ItemType Directory -Force -Path (Join-Path $prepared 'notices')
    Copy-Item -LiteralPath (Join-Path $sdkRoot.FullName 'bin\NVAudioEffects.dll') -Destination $runtime.FullName
    Get-ChildItem -LiteralPath (Join-Path $sdkRoot.FullName 'bin\external') -Filter '*.dll' -File -Recurse |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $runtime.FullName }
    Copy-Item -LiteralPath (Join-Path $sdkRoot.FullName 'bin\models\denoiser_48k.trtpkg') -Destination $models.FullName
    Get-ChildItem -LiteralPath $sdkRoot.FullName -File |
        Where-Object { $_.Extension -eq '.pdf' -or $_.Name -match 'License' } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $notices.FullName }
    Copy-Item -LiteralPath (Join-Path $sdkRoot.FullName 'bin\external\ThirdPartyLicenses.txt') -Destination $notices.FullName

    $manifest = [ordered]@{
        schemaVersion = 1
        sdkDll = 'runtime/NVAudioEffects.dll'
        model = 'models/denoiser_48k.trtpkg'
    }
    $manifestJson = $manifest | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $prepared 'setup.json'), $manifestJson, [Text.UTF8Encoding]::new($false))

    $backup = "$destinationFull.backup-$([Guid]::NewGuid().ToString('N'))"
    if (Test-Path -LiteralPath $destinationFull) { Move-Item -LiteralPath $destinationFull -Destination $backup }
    try {
        Move-Item -LiteralPath $prepared -Destination $destinationFull
        if (Test-Path -LiteralPath $backup) {
            try { Remove-Item -LiteralPath $backup -Recurse -Force } catch { }
        }
    } catch {
        if (Test-Path -LiteralPath $destinationFull) { Remove-Item -LiteralPath $destinationFull -Recurse -Force }
        if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $destinationFull }
        throw
    }
} finally {
    if (Test-Path -LiteralPath $workingFull) { Remove-Item -LiteralPath $workingFull -Recurse -Force }
}
