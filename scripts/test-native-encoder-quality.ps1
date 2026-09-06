param(
    [string]$OutputDirectory = ".local/capture-probe/quality"
)

$ErrorActionPreference = "Stop"

function Resolve-FFmpeg([string]$Name) {
    $base = Join-Path $env:LOCALAPPDATA "Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    $candidate = Get-ChildItem -LiteralPath $base -Directory |
        ForEach-Object { Join-Path $_.FullName "bin/$Name.exe" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Sort-Object |
        Select-Object -Last 1
    if (-not $candidate) { throw "$Name was not found in the Gyan FFmpeg WinGet package" }
    return $candidate
}

function Assert-Exit([string]$Operation) {
    if ($LASTEXITCODE -ne 0) { throw "$Operation failed with exit code $LASTEXITCODE" }
}

$ffmpeg = Resolve-FFmpeg "ffmpeg"
$ffprobe = Resolve-FFmpeg "ffprobe"
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$reference = Join-Path $OutputDirectory "reference.mkv"
$source = "nullsrc=s=1920x1080:r=60:d=3,geq=lum='16+48*X/W+4*mod(floor(X/4)+floor(Y/4)\,2)+70*between(X\,mod(N*8\,1680)\,mod(N*8\,1680)+240)*between(Y\,650\,850)':cb='128+10*sin(X/31)+6*cos(Y/17)':cr='128+8*cos(X/27)-6*sin(Y/19)',format=yuv420p"
& $ffmpeg -y -hide_banner -loglevel error -f lavfi -i $source -frames:v 180 -c:v ffv1 -level 3 $reference
Assert-Exit "lossless fixture generation"

$common = @(
    "-y", "-hide_banner", "-loglevel", "info", "-benchmark", "-i", $reference,
    "-an", "-frames:v", "180", "-c:v", "h264_nvenc", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-color_range", "tv", "-profile:v", "baseline", "-bf", "0", "-g", "60",
    "-b:v", "20M", "-maxrate", "20M", "-bufsize", "10M"
)
$profiles = @{
    current = @("-preset", "p4", "-tune", "ull", "-rc", "cbr", "-zerolatency", "1")
    proposed = @("-preset", "p5", "-tune", "ll", "-rc", "cbr", "-zerolatency", "1", "-rc-lookahead", "0", "-spatial-aq", "1", "-aq-strength", "8", "-multipass", "qres")
}
$runs = @()
foreach ($mode in @("current", "proposed")) {
    foreach ($run in 1..3) {
        $specific = $profiles[$mode]
        $output = Join-Path $OutputDirectory "$mode-$run.mp4"
        $log = Join-Path $OutputDirectory "$mode-$run.log"
        $timer = [Diagnostics.Stopwatch]::StartNew()
        & $ffmpeg @common @specific $output 2> $log
        $timer.Stop()
        Assert-Exit "$mode encode run $run"
        $bytes = (Get-Item -LiteralPath $output).Length
        $runs += [pscustomobject]@{ mode=$mode; run=$run; wallMs=$timer.Elapsed.TotalMilliseconds; bytes=$bytes }
    }
}
$runs | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory "encode-results.json")

foreach ($mode in @("current", "proposed")) {
    $encoded = Join-Path $OutputDirectory "$mode-1.mp4"
    & $ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,avg_frame_rate,nb_frames,bit_rate -show_entries format=duration,size,bit_rate -of json $encoded |
        Set-Content -LiteralPath (Join-Path $OutputDirectory "$mode-probe.json")
    Assert-Exit "$mode stream validation"
    foreach ($metric in @("psnr", "ssim", "xpsnr", "libvmaf")) {
        & $ffmpeg -hide_banner -loglevel info -i $encoded -i $reference -lavfi "[0:v][1:v]$metric" -f null NUL 2> (Join-Path $OutputDirectory "$mode-$metric.log")
        Assert-Exit "$mode $metric"
    }
    foreach ($metric in @("psnr", "ssim", "libvmaf")) {
        $graph = "[0:v]crop=1920:540:0:0[d];[1:v]crop=1920:540:0:0[r];[d][r]$metric"
        & $ffmpeg -hide_banner -loglevel info -i $encoded -i $reference -filter_complex $graph -f null NUL 2> (Join-Path $OutputDirectory "$mode-dark-$metric.log")
        Assert-Exit "$mode dark $metric"
    }
}

Write-Host "Quality probe passed. Inspect encode-results.json, *-probe.json, and metric logs in $OutputDirectory"
