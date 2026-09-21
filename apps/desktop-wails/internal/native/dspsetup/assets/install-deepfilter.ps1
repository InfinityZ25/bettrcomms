[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$BundledAssets
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.IO.Compression.FileSystem

$maximumFileBytes = 210000000L
$maximumTotalBytes = 216000000L
$downloadedBytes = 0L

$ortUrl = 'https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/1.23.0/microsoft.ml.onnxruntime.directml.1.23.0.nupkg'
$ortBytes = 12746067L
$ortSha256 = 'A33EC2382B3C440BAB74042A135733BB6E5085F293B908D3997688A58FE307E7'
$directmlUrl = 'https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg'
$directmlBytes = 202292617L
$directmlSha256 = '4E7CB7DDCE8CF837A7A75DC029209B520CA0101470FCDF275C1F49736A3615B9'
function Get-FullPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Receive-PinnedFile(
    [string]$Url,
    [string]$Output,
    [long]$ExpectedBytes,
    [string]$ExpectedHash
) {
    if ($ExpectedBytes -gt $maximumFileBytes) { throw 'Pinned asset exceeds the per-file size cap' }
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $true
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        [void]$response.EnsureSuccessStatusCode()
        $length = $response.Content.Headers.ContentLength
        if ($null -ne $length -and ($length -ne $ExpectedBytes -or $length -gt $maximumFileBytes)) {
            throw "Unexpected download size for $Url`: $length bytes"
        }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [System.IO.File]::Create($Output)
        $buffer = New-Object byte[] 1048576
        $received = 0L
        $deadline = [DateTime]::UtcNow.AddMinutes(10)
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
                if ($received -gt $ExpectedBytes -or $received -gt $maximumFileBytes) {
                    throw 'Download exceeded its pinned size'
                }
                $outputStream.Write($buffer, 0, $read)
            }
        } finally {
            $outputStream.Dispose()
            $inputStream.Dispose()
        }
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }
    $actualBytes = (Get-Item -LiteralPath $Output).Length
    if ($actualBytes -ne $ExpectedBytes) {
        throw "Downloaded file has unexpected size: $actualBytes bytes"
    }
    $script:downloadedBytes += $actualBytes
    if ($script:downloadedBytes -gt $maximumTotalBytes) { throw 'Downloads exceeded the total size cap' }
    $actualHash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash
    if ($actualHash -ne $ExpectedHash) { throw 'Downloaded file failed SHA-256 verification' }
}

function Copy-ZipEntry(
    [System.IO.Compression.ZipArchive]$Archive,
    [string]$EntryName,
    [string]$Output,
    [long]$MaximumBytes
) {
    $entry = $Archive.GetEntry($EntryName)
    if ($null -eq $entry -or $entry.Length -gt $MaximumBytes) {
        throw "Pinned package is missing or exceeds the size cap for $EntryName"
    }
    $parent = [System.IO.Path]::GetDirectoryName($Output)
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    $inputStream = $entry.Open()
    $outputStream = [System.IO.File]::Create($Output)
    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    if ((Get-Item -LiteralPath $Output).Length -ne $entry.Length) {
        throw "Extracted file length mismatch for $EntryName"
    }
}

function Test-BundledFile([string]$Name, [long]$ExpectedBytes, [string]$ExpectedHash) {
    $path = Join-Path $bundledFull $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
        (Get-Item -LiteralPath $path).Length -ne $ExpectedBytes -or
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $ExpectedHash) {
        throw "Bundled DeepFilterNet asset failed its pinned size or SHA-256 check: $Name"
    }
}

$destinationFull = Get-FullPath $Destination
$workingFull = Get-FullPath $WorkingDirectory
$bundledFull = Get-FullPath $BundledAssets
$expectedParent = Get-FullPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Bettercomms')
if ((Get-FullPath ([System.IO.Path]::GetDirectoryName($destinationFull))) -ne $expectedParent -or
    [System.IO.Path]::GetFileName($destinationFull) -ne 'deepfilter-directml') {
    throw 'Destination is outside the Bettercomms application data directory'
}
if ((Get-FullPath ([System.IO.Path]::GetDirectoryName($workingFull))) -ne $expectedParent -or
    [System.IO.Path]::GetFileName($workingFull) -notlike 'deepfilter-install-*' -or
    $workingFull -eq $destinationFull) {
    throw 'Working directory is outside the Bettercomms application data directory'
}
if ($bundledFull -ne (Get-FullPath (Join-Path $workingFull 'bundled'))) {
    throw 'Bundled assets are outside the private DeepFilterNet staging directory'
}

New-Item -ItemType Directory -Force -Path $expectedParent | Out-Null
if ((Get-Item -LiteralPath $expectedParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Bettercomms application data directory cannot be a reparse point'
}
if ((Test-Path -LiteralPath $destinationFull) -and
    ((Get-Item -LiteralPath $destinationFull -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'DeepFilterNet destination cannot be a reparse point'
}
New-Item -ItemType Directory -Force -Path $workingFull | Out-Null
if ((Get-Item -LiteralPath $workingFull -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'DeepFilterNet working directory cannot be a reparse point'
}

$ortPackage = Join-Path $workingFull 'onnxruntime-directml.nupkg'
$directmlPackage = Join-Path $workingFull 'directml.nupkg'
$prepared = Join-Path $workingFull 'prepared'
$runtime = New-Item -ItemType Directory -Force -Path (Join-Path $prepared 'runtime')
$models = New-Item -ItemType Directory -Force -Path (Join-Path $prepared 'models')
$notices = New-Item -ItemType Directory -Force -Path (Join-Path $prepared 'notices')

try {
    Receive-PinnedFile $ortUrl $ortPackage $ortBytes $ortSha256
    Receive-PinnedFile $directmlUrl $directmlPackage $directmlBytes $directmlSha256
    $modelPath = Join-Path $bundledFull 'denoiser_model.onnx'
    Test-BundledFile 'denoiser_model.onnx' 12912242L '41AB21252F5357D3FF29999BA37D7B529BCBBB60D3B7E2B8D720726185BB4740'
    Test-BundledFile 'initial_states.json' 187320L 'F430F056519C5B6EC2D949676CD2BE29B62554F249F74683D681FEFE6916C88C'
    Test-BundledFile 'meta.json' 1154L '41C206BD017A6314BB61C5EBC16CC773BCE2D67B0DCE91C5035DBD9D064586DE'
    Test-BundledFile 'deepfilter-stream-LICENSE' 1084L '7A79C7F83B5132D1BF00B3D82EF918AAFCAD4F11C7A6C075303A49A36F50D60C'
    Test-BundledFile 'deepfilter-stream-NOTICE' 385L '1685F2E068805D9F904439A6047391896A1DD5080BD034AFC58F3C851D798BEC'
    Test-BundledFile 'DeepFilterNet-LICENSE' 507L '3419DD73E7C427E49BDFFD9F1E7297438F07AA65AE1B65AE167D6445BFA8FA41'
    Test-BundledFile 'DeepFilterNet-LICENSE-APACHE' 11038L '2D71D2472AE6446E986CC9AD3EC6182B91868C639734F838AA1D03888838EF56'
    Test-BundledFile 'DeepFilterNet-LICENSE-MIT' 1102L 'D38482491663EE5C55BB9FD4A7A193F1652157BA85A4BE5D4E8A50649B2CBC3D'

    $ortZip = [IO.Compression.ZipFile]::OpenRead($ortPackage)
    try {
        Copy-ZipEntry $ortZip 'runtimes/win-x64/native/onnxruntime.dll' (Join-Path $runtime.FullName 'onnxruntime.dll') 20000000L
        Copy-ZipEntry $ortZip 'runtimes/win-x64/native/onnxruntime_providers_shared.dll' (Join-Path $runtime.FullName 'onnxruntime_providers_shared.dll') 1000000L
        Copy-ZipEntry $ortZip 'LICENSE' (Join-Path $notices.FullName 'onnxruntime-LICENSE') 100000L
        Copy-ZipEntry $ortZip 'ThirdPartyNotices.txt' (Join-Path $notices.FullName 'onnxruntime-ThirdPartyNotices.txt') 1000000L
    } finally { $ortZip.Dispose() }

    $directmlZip = [IO.Compression.ZipFile]::OpenRead($directmlPackage)
    try {
        Copy-ZipEntry $directmlZip 'bin/x64-win/DirectML.dll' (Join-Path $runtime.FullName 'DirectML.dll') 20000000L
        Copy-ZipEntry $directmlZip 'LICENSE.txt' (Join-Path $notices.FullName 'directml-LICENSE.txt') 100000L
        Copy-ZipEntry $directmlZip 'LICENSE-CODE.txt' (Join-Path $notices.FullName 'directml-LICENSE-CODE.txt') 100000L
        Copy-ZipEntry $directmlZip 'ThirdPartyNotices.txt' (Join-Path $notices.FullName 'directml-ThirdPartyNotices.txt') 100000L
    } finally { $directmlZip.Dispose() }

    Copy-Item -LiteralPath $modelPath -Destination $models.FullName
    Copy-Item -LiteralPath (Join-Path $bundledFull 'initial_states.json') -Destination $models.FullName
    Copy-Item -LiteralPath (Join-Path $bundledFull 'meta.json') -Destination $models.FullName
    foreach ($notice in @(
        'deepfilter-stream-LICENSE', 'deepfilter-stream-NOTICE', 'DeepFilterNet-LICENSE',
        'DeepFilterNet-LICENSE-APACHE', 'DeepFilterNet-LICENSE-MIT'
    )) {
        Copy-Item -LiteralPath (Join-Path $bundledFull $notice) -Destination $notices.FullName
    }
    $modelNotice = @'
Bettercomms DirectML graph adaptation

The bundled denoiser_model.onnx is derived from deepfilter-stream release
model-dfn3-512-v1 at commit be1a989760c93f3107c0c39a6d866df8d6bd40b2.
Bettercomms losslessly converted 15 FusedConv nodes to standard ONNX Conv nodes
so the graph can execute with strict DirectML placement and CPU fallback disabled.
Adapted graph SHA-256: 41ab21252f5357d3ff29999ba37d7b529bcbbb60d3b7e2b8d720726185bb4740
'@
    [IO.File]::WriteAllText((Join-Path $notices.FullName 'Bettercomms-MODEL-NOTICE.txt'), $modelNotice, [Text.UTF8Encoding]::new($false))

    $manifest = [ordered]@{
        schemaVersion = 1
        runtimeDll = 'runtime/onnxruntime.dll'
        providerSharedDll = 'runtime/onnxruntime_providers_shared.dll'
        directmlDll = 'runtime/DirectML.dll'
        model = 'models/denoiser_model.onnx'
        initialStates = 'models/initial_states.json'
        metadata = 'models/meta.json'
        sampleRate = 48000
        frameSamples = 512
        onnxRuntimeVersion = '1.23.0'
        directmlVersion = '1.15.4'
        deepfilterStreamCommit = 'be1a989760c93f3107c0c39a6d866df8d6bd40b2'
        modelRelease = 'model-dfn3-512-v1'
        modelSha256 = '41ab21252f5357d3ff29999ba37d7b529bcbbb60d3b7e2b8d720726185bb4740'
        initialStatesSha256 = 'f430f056519c5b6ec2d949676cd2be29b62554f249f74683d681fefe6916c88c'
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
