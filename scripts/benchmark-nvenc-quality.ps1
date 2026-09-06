param(
    [int]$DurationSeconds = 6,
    [int[]]$BitratesMbps = @(8, 12, 20),
    [string[]]$ProfileNames = @(),
    [string]$OutputDirectory = ".local/nvenc-quality"
)

$ErrorActionPreference = "Stop"
if ($DurationSeconds -lt 3 -or $DurationSeconds -gt 60) { throw "DurationSeconds must be 3-60." }
if ($BitratesMbps.Count -eq 0 -or ($BitratesMbps | Where-Object { $_ -lt 4 -or $_ -gt 80 })) {
    throw "BitratesMbps must contain values from 4-80."
}

$ffmpeg = Get-ChildItem "$env:LOCALAPPDATA/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe" -Recurse -Filter ffmpeg.exe |
    Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName
$ffprobe = Join-Path (Split-Path $ffmpeg) "ffprobe.exe"
if (-not (Test-Path $ffmpeg) -or -not (Test-Path $ffprobe)) { throw "FFmpeg 8.1 full build was not found." }

$outputRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../$OutputDirectory"))

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$fixture = "testsrc2=size=1920x1080:rate=60:duration=$DurationSeconds,drawgrid=width=48:height=48:thickness=1:color=white@0.22,drawbox=x=mod(t*413\,1720):y=mod(t*227\,820):w=200:h=200:color=yellow@0.9:t=fill,drawbox=x=1720-mod(t*317\,1720):y=820-mod(t*181\,820):w=140:h=140:color=cyan@0.9:t=fill,drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='BetterComms HUD 1080p60':x=48+mod(t*240\,1100):y=64:fontsize=44:fontcolor=white:borderw=2:bordercolor=black"
$common = @("-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", $fixture, "-an", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-bf", "0", "-rc", "cbr", "-rc-lookahead", "0", "-zerolatency", "1")
$profiles = @(
    @{ Name = "baseline-p5-ll-g60"; Args = @("-profile:v", "baseline", "-preset", "p5", "-tune", "ll", "-g", "60", "-spatial-aq", "1", "-aq-strength", "8", "-temporal-aq", "0", "-multipass", "qres") },
    @{ Name = "main-p5-ll-g120"; Args = @("-profile:v", "main", "-preset", "p5", "-tune", "ll", "-g", "120", "-spatial-aq", "1", "-aq-strength", "8", "-temporal-aq", "0", "-multipass", "qres") },
    @{ Name = "main-p5-ll-g300"; Args = @("-profile:v", "main", "-preset", "p5", "-tune", "ll", "-g", "300", "-spatial-aq", "1", "-aq-strength", "8", "-temporal-aq", "0", "-multipass", "qres") },
    @{ Name = "main-p6-full-aq-g120"; Args = @("-profile:v", "main", "-preset", "p6", "-tune", "ll", "-g", "120", "-spatial-aq", "1", "-aq-strength", "8", "-temporal-aq", "1", "-multipass", "fullres") },
    @{ Name = "main-p6-full-aq-g300"; Args = @("-profile:v", "main", "-preset", "p6", "-tune", "ll", "-g", "300", "-spatial-aq", "1", "-aq-strength", "8", "-temporal-aq", "1", "-multipass", "fullres") }
)
if ($ProfileNames.Count -gt 0) {
    $profiles = @($profiles | Where-Object { $_.Name -in $ProfileNames })
    if ($profiles.Count -ne $ProfileNames.Count) { throw "One or more requested profile names are unknown." }
}

$results = @()
foreach ($bitrate in $BitratesMbps) {
    foreach ($profile in $profiles) {
        $name = "$($profile.Name)-${bitrate}m"
        $video = Join-Path $outputRoot "$name.mp4"
        $timer = [Diagnostics.Stopwatch]::StartNew()
        & $ffmpeg @common -c:v h264_nvenc @($profile.Args) -b:v "${bitrate}M" -maxrate "${bitrate}M" -bufsize "$([Math]::Max(1, [Math]::Floor($bitrate / 2)))M" -movflags +faststart $video
        if ($LASTEXITCODE -ne 0) { throw "Encode failed: $name" }
        $timer.Stop()
        $bytes = (Get-Item $video).Length
        $actualMbps = [Math]::Round(($bytes * 8 / $DurationSeconds / 1000000), 3)
        $throughputFps = [Math]::Round(($DurationSeconds * 60 / $timer.Elapsed.TotalSeconds), 1)

        $vmafLog = Join-Path $outputRoot "$name-vmaf.json"
        $metricLog = Join-Path $outputRoot "$name-metrics.txt"
        $escapedVmaf = $vmafLog.Replace("\", "/").Replace(":", "\:")
        $filter = "[0:v]setpts=PTS-STARTPTS[dist];[1:v]setpts=PTS-STARTPTS[ref];[dist][ref]libvmaf=log_fmt=json:log_path='$escapedVmaf'"
        & $ffmpeg -hide_banner -loglevel error -i $video -f lavfi -i $fixture -filter_complex $filter -an -f null - 2>&1 | Set-Content $metricLog
        if ($LASTEXITCODE -ne 0) { throw "VMAF failed: $name" }
        $vmaf = [Math]::Round([double]((Get-Content $vmafLog -Raw | ConvertFrom-Json).pooled_metrics.vmaf.mean), 3)

        $ssimOutput = (& $ffmpeg -hide_banner -i $video -f lavfi -i $fixture -lavfi "[0:v][1:v]ssim" -an -f null - 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { throw "SSIM failed: $name" }
        $ssimMatch = [regex]::Match($ssimOutput, "All:([0-9.]+)")
        if (-not $ssimMatch.Success) { throw "Could not parse SSIM: $name" }
        $ssim = [Math]::Round([double]$ssimMatch.Groups[1].Value, 6)
        $results += [pscustomobject]@{
            profile = $profile.Name; targetMbps = $bitrate; actualMbps = $actualMbps
            vmaf = $vmaf; ssim = $ssim; encodeFps = $throughputFps
            realtimeMultiple = [Math]::Round($throughputFps / 60, 2); bytes = $bytes
        }
        $results[-1] | Format-Table | Out-String | Write-Host
    }
}

$results | Export-Csv -NoTypeInformation (Join-Path $outputRoot "results.csv")
$results | ConvertTo-Json | Set-Content (Join-Path $outputRoot "results.json")
$results | Sort-Object targetMbps, @{ Expression = "vmaf"; Descending = $true } | Format-Table -AutoSize

