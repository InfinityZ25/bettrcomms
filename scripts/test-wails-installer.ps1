# Real, opt-in install/upgrade/uninstall acceptance. Never overwrite an existing
# Wails registration or shortcut. Tauri and webview profiles are not touched.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$registry = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/BetterComms-Wails'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'BetterComms (Wails).lnk'
if ((Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath $shortcut)) {
    throw 'An existing Wails installation/shortcut must not be modified by this test.'
}
$root = Join-Path $repo ('.local/wails-installer-test-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $root)
$destination = Join-Path $root 'installed'
$source = Join-Path $repo 'apps/desktop-wails/bin'
$expectedVersion = (Get-Content -LiteralPath (Join-Path $repo 'apps/desktop-wails/package.json') -Raw | ConvertFrom-Json).version + '-wails'
function Assert-Installed {
    foreach ($file in @('bettercomms-wails.exe', 'ffmpeg/ffmpeg.exe', 'ffmpeg/LICENSE', 'ffmpeg/SOURCE.txt', 'ffmpeg/setup.json')) {
        $installed = Join-Path $destination $file
        if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { throw "Missing installed file: $file" }
        if ((Get-FileHash -LiteralPath $installed).Hash -ne (Get-FileHash -LiteralPath (Join-Path $source $file)).Hash) {
            throw "Installed bytes differ: $file"
        }
    }
    if (-not (Test-Path -LiteralPath $shortcut)) { throw 'Start menu shortcut is absent.' }
    if ((Get-ItemProperty -LiteralPath $registry).InstallLocation -ne $destination) { throw 'Install registration points elsewhere.' }
    $metadata = & (Join-Path $destination 'bettercomms-wails.exe') --print-build-info
    if ($LASTEXITCODE -ne 0 -or ($metadata | ConvertFrom-Json).version -ne $expectedVersion) {
        throw 'Installed executable metadata probe failed.'
    }
}
function Invoke-Install {
    param([switch]$UseRegisteredDirectory)
    # NSIS requires /D last and without quote characters, including for spaces.
    $arguments = if ($UseRegisteredDirectory) { '/S' } else { "/S /D=$destination" }
    $process = Start-Process -FilePath $installerPath -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Installer exit code: $($process.ExitCode)" }
    Assert-Installed
}
Invoke-Install
$uninstaller = Join-Path $destination 'uninstall.exe'
# A Windows sharing lock exercises the OS-level refusal without starting a
# camera, call, GPU or user-facing window. Test both the host and media worker.
foreach ($lockedFile in @('bettercomms-wails.exe', 'ffmpeg/ffmpeg.exe')) {
    $lockPath = Join-Path $destination $lockedFile
    $fileLock = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $attempt = Start-Process -FilePath $installerPath -ArgumentList "/S /D=$destination" -PassThru -Wait -WindowStyle Hidden
        if ($attempt.ExitCode -ne 67) { throw "Upgrade did not refuse locked payload: $lockedFile (exit $($attempt.ExitCode))" }
        # Run in place only for refusal, so the exit code belongs to the actual
        # uninstaller rather than its TEMP launcher. Nothing should be deleted.
        $attempt = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$destination" -PassThru -Wait -WindowStyle Hidden
        if ($attempt.ExitCode -ne 67) { throw "Uninstall did not refuse locked payload: $lockedFile (exit $($attempt.ExitCode))" }
    } finally { $fileLock.Dispose() }
    Assert-Installed
    if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Refused uninstall removed its recovery entry point.' }
}
$sentinel = Join-Path $destination 'user-data-must-survive.txt'
[IO.File]::WriteAllText($sentinel, 'Installer acceptance: preserve unknown files.')
Invoke-Install -UseRegisteredDirectory
if (-not (Test-Path -LiteralPath $sentinel)) { throw 'Upgrade removed a user file.' }
$uninstaller = Join-Path $destination 'uninstall.exe'
# NSIS may relaunch from TEMP; also wait for its authoritative file/registry
# postconditions instead of mistaking the launcher's exit for completion.
$process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw "Uninstaller exit code: $($process.ExitCode)" }
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ((Test-Path -LiteralPath $uninstaller) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
foreach ($file in @('bettercomms-wails.exe', 'uninstall.exe', 'ffmpeg/ffmpeg.exe', 'ffmpeg/LICENSE', 'ffmpeg/SOURCE.txt', 'ffmpeg/setup.json')) {
    if (Test-Path -LiteralPath (Join-Path $destination $file)) { throw "Uninstall retained a package file: $file" }
}
if ((Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath $shortcut)) { throw 'Uninstall retained registration or shortcut.' }
if ((Get-Content -LiteralPath $sentinel -Raw) -ne 'Installer acceptance: preserve unknown files.') { throw 'Uninstall changed user data.' }
Write-Host 'Install, locked-payload refusal, same-version upgrade, executable metadata, payload hashes and uninstall preservation passed.'
Write-Host "Acceptance directory retained for inspection: $root"
