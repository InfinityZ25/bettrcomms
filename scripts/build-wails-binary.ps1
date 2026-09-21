[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wails-build-origin.ps1')
$origin = ConvertTo-WailsBuildOrigin $env:BETTERCOMMS_BUILD_API_ORIGIN
$app = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/desktop-wails'
$buildArguments = @('build', '-tags', 'production', '-o', 'bin/bettercomms-wails.exe')
if ($origin) { $buildArguments += @('-ldflags', "-X main.bakedAPIOrigin=$origin") }
$buildArguments += '.'
Push-Location $app
try {
    & go @buildArguments
    if ($LASTEXITCODE -ne 0) { throw 'Wails host compilation failed.' }
} finally { Pop-Location }
