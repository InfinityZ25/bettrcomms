[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wails-build-origin.ps1')
foreach ($invalid in @('http://localhost:8080', 'https://user:secret@example.test',
    'https://example.test/api', 'https://example.test?token=x', 'https://example.test#x',
    'https://example.test -X main.other=value', 'https://example.test/../',
    'https://example.test:99999', 'https://')) {
    $rejected = $false
    try { [void](ConvertTo-WailsBuildOrigin $invalid) } catch { $rejected = $true }
    if (-not $rejected) { throw 'Build origin validation accepted a forbidden URL.' }
}
if ((ConvertTo-WailsBuildOrigin 'https://BUILD.example:8443/') -ne 'https://build.example:8443') {
    throw 'Build origin canonicalisation failed.'
}
if ((ConvertTo-WailsBuildOrigin '') -ne '') { throw 'The default build must not override the repository origin.' }

$previousBuildOrigin = $env:BETTERCOMMS_BUILD_API_ORIGIN
$previousRuntimeOrigin = $env:BETTERCOMMS_API_ORIGIN
$app = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/desktop-wails'
$executable = Join-Path $app 'bin/bettercomms-wails.exe'
try {
    $env:BETTERCOMMS_BUILD_API_ORIGIN = 'https://packaging.example:8443'
    & (Join-Path $PSScriptRoot 'build-wails-binary.ps1')
    $env:BETTERCOMMS_BUILD_API_ORIGIN = $null
    $env:BETTERCOMMS_API_ORIGIN = $null
    $metadata = & $executable --print-build-info
    if ($LASTEXITCODE -ne 0) { throw 'The packaged metadata probe failed.' }
    if (($metadata | ConvertFrom-Json).apiOrigin -ne 'https://packaging.example:8443') {
        throw 'The executable lost its custom API origin when the build environment was removed.'
    }
    Write-Host 'Custom HTTPS API origin persists in the executable without build or runtime environment variables.'
} finally {
    # Leave the actual distributable configured for the caller's build, never
    # for the deliberately unreachable acceptance-test domain.
    $env:BETTERCOMMS_BUILD_API_ORIGIN = $previousBuildOrigin
    $env:BETTERCOMMS_API_ORIGIN = $previousRuntimeOrigin
    & (Join-Path $PSScriptRoot 'build-wails-binary.ps1')
}
