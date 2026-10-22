# One-command local Orca relay stack.
#
#   cloud/scripts/dev-relay.ps1            # everything: auth + relay + tailscale + desktop
#   cloud/scripts/dev-relay.ps1 -NoDesktop # just the backend services
#
# After it runs, the dev desktop's "Orca Relay" toggle goes green and the QR
# uses https://<host>.ts.net — reachable by the phone over tailscale.

param(
  [string]$TailscaleHost = 'desktop-odabh49.tail2027d1.ts.net',
  [int]$AuthPort = 8787,
  [int]$RelayPort = 8080,
  [switch]$NoDesktop
)

$ErrorActionPreference = 'Stop'
$cloud = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $cloud
$publicUrl = "https://$TailscaleHost"

function Test-PortFree([int]$Port) {
  return -not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-Logged([string]$Name, [string]$WorkDir, [string]$CmdLine) {
  $out = "$env:TEMP\orca-$Name.log"
  $err = "$env:TEMP\orca-$Name.err"
  $p = Start-Process -PassThru -WindowStyle Hidden -FilePath 'cmd.exe' `
    -ArgumentList '/c', $CmdLine `
    -WorkingDirectory $WorkDir `
    -RedirectStandardOutput $out -RedirectStandardError $err
  Write-Host "   $Name pid $($p.Id) -> $out"
}

Write-Host "== dev-auth :$AuthPort" -ForegroundColor Cyan
if (Test-PortFree $AuthPort) {
  Start-Logged 'dev-auth' (Join-Path $cloud 'apps/dev-auth') `
    "set PORT=$AuthPort&& pnpm dev >`"$env:TEMP\orca-dev-auth.log`" 2>`"$env:TEMP\orca-dev-auth.err`""
  Start-Sleep -Seconds 3
} else {
  Write-Host "   already running"
}

Write-Host "== relay :$RelayPort -> $publicUrl" -ForegroundColor Cyan
if (Test-PortFree $RelayPort) {
  $envSets = @(
    "PORT=$RelayPort",
    "ORCA_RELAY_PUBLIC_URL=$publicUrl",
    "ORCA_RELAY_CELL_URL=$publicUrl",
    "ORCA_RELAY_AUTH_ISSUER=http://localhost:$AuthPort",
    "ORCA_RELAY_JWKS_URL=http://localhost:$AuthPort/.well-known/jwks.json",
    "ORCA_RELAY_ASSIGNMENT_SIGNING_KEY=dev-signing-key-please-use-32bytes-minimum-xxxxxxxx",
    "ORCA_RELAY_ADMIN_AUDIENCE=$publicUrl",
    "ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT=dev@localhost.dev",
    "ORCA_RELAY_PUBLIC_ASSIGNMENTS_ENABLED=true",
    "ORCA_RELAY_REGIONAL_PLACEMENT_ENABLED=false",
    "ORCA_RELAY_DATA_DIR=./data/dev-relay"
  ) -join '&& set '
  Start-Logged 'relay' (Join-Path $cloud 'apps/relay') `
    "set $envSets&& pnpm dev >`"$env:TEMP\orca-relay.log`" 2>`"$env:TEMP\orca-relay.err`""
  Start-Sleep -Seconds 3
} else {
  Write-Host "   already running"
}

$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $tailscale) {
  Write-Host "== tailscale serve $publicUrl" -ForegroundColor Cyan
  $serveOutput = & $tailscale serve --bg --https=443 "http://localhost:$RelayPort" 2>&1
  $serveOutput | ForEach-Object { Write-Host "   $_" }
  if ($LASTEXITCODE -ne 0 -or ($serveOutput | Select-String 'not enabled')) {
    Write-Warning "tailscale serve not enabled — phone won't reach the relay until you click the admin URL above once."
  }
} else {
  Write-Warning "tailscale.exe not found"
}

if ($NoDesktop) {
  Write-Host "`nBackend up. Desktop env (if you run it yourself):" -ForegroundColor Green
  Write-Host "  ORCA_CLOUD_DEV_AUTH=1"
  Write-Host "  ORCA_CLOUD_API_URL=http://localhost:$AuthPort"
  Write-Host "  ORCA_CLOUD_CLIENT_ID=orca-desktop-dev"
  Write-Host "  ORCA_RELAY_URL=$publicUrl"
  exit 0
}

Write-Host "`n== desktop" -ForegroundColor Cyan
$env:ORCA_CLOUD_DEV_AUTH = '1'
$env:ORCA_CLOUD_API_URL = "http://localhost:$AuthPort"
$env:ORCA_CLOUD_CLIENT_ID = 'orca-desktop-dev'
$env:ORCA_RELAY_URL = $publicUrl
$env:ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION = '1'
$env:ORCA_UNPACKAGED = '1'
# Why: the Tauri PoC launches orcad on loopback by default; pairing offers need the
# WS listener reachable on the Tailnet, so bind to all interfaces for this stack.
$env:ORCA_RUNTIME_BIND_HOST = '0.0.0.0'
# Unset so the dev window shows normally instead of staying hidden.
$env:ORCA_BACKGROUND_LAUNCH = '0'
Push-Location $repo
try { pnpm dev } finally { Pop-Location }
