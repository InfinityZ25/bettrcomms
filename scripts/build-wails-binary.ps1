[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wails-build-origin.ps1')
$origin = ConvertTo-WailsBuildOrigin $env:BETTERCOMMS_BUILD_API_ORIGIN
$updateFlags = & node (Join-Path $PSScriptRoot 'wails-update-build-flags.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Invalid public desktop update build configuration.' }
$app = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/desktop-wails'
$buildArguments = @('build', '-tags', 'production', '-o', 'bin/bettercomms-wails.exe')
$linkFlags = @()
if ($origin) { $linkFlags += "-X main.bakedAPIOrigin=$origin" }
if ($updateFlags) { $linkFlags += $updateFlags }
if ($linkFlags.Count) { $buildArguments += @('-ldflags', ($linkFlags -join ' ')) }
$buildArguments += '.'
Push-Location $app
try {
    & go @buildArguments
    if ($LASTEXITCODE -ne 0) { throw 'Wails host compilation failed.' }
} finally { Pop-Location }
