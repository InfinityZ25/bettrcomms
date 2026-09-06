$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$localDir=Join-Path $projectRoot '.local'
New-Item -ItemType Directory -Path $localDir -Force | Out-Null
$secretPath=Join-Path $localDir 'turn-secret'
if (!(Test-Path -LiteralPath $secretPath)) {
  $secretBytes=New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Fill($secretBytes)
  [IO.File]::WriteAllText($secretPath,[Convert]::ToBase64String($secretBytes))
}
$turnSecret=[IO.File]::ReadAllText($secretPath)
$turnConfig=@"
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$turnSecret
realm=bettercomms.local
min-port=49160
max-port=49179
no-cli
no-tls
no-dtls
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
user-quota=12
total-quota=120
log-file=stdout
simple-log
"@
[IO.File]::WriteAllText((Join-Path $localDir 'turnserver.conf'),$turnConfig)
Push-Location $projectRoot
try { docker compose --profile relay up -d turn } finally { Pop-Location }
