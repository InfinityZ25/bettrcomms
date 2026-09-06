param([switch]$DevAuth)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDir = Join-Path $projectRoot '.local'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$env:DATABASE_URL = 'postgres://bettercomms:local-development-only@127.0.0.1:54329/bettercomms?sslmode=disable'
$env:HTTP_ADDR = '127.0.0.1:8080'
$env:APP_URL = 'http://localhost:5173'
$env:WORKOS_REDIRECT_URI = 'http://localhost:5173/api/v1/auth/callback'
$env:DEV_AUTH = if ($DevAuth) { 'true' } else { 'false' }
$turnSecretFile = Join-Path $localDir 'turn-secret'
if (Test-Path -LiteralPath $turnSecretFile) {
  $env:TURN_SECRET = [IO.File]::ReadAllText($turnSecretFile)
  $env:TURN_URLS = 'turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp'
}
Push-Location (Join-Path $projectRoot 'server')
try { go run ./cmd/server } finally { Pop-Location }
