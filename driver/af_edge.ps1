# AF-Fill driver: launch dedicated Edge profile with CDP debug port.
# ASCII-only on purpose (avoid PS5 encoding issues).
param([switch]$Close)
$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content (Join-Path $dir 'config.json') -Raw | ConvertFrom-Json
$port = $cfg.debugPort
$udd  = $cfg.edgeProfileDir

function Test-Port([int]$p) {
  try { $null = Invoke-RestMethod "http://127.0.0.1:$p/json/version" -TimeoutSec 2; return $true } catch { return $false }
}

if ($Close) {
  if (Test-Port $port) {
    # close only the pages of this debug instance, then quit via CDP Browser.close is not exposed to HTTP;
    # simplest reliable way: kill processes whose command line contains our user-data-dir.
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$udd*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep 1
  }
  Write-Output 'AF-EDGE CLOSED'
  exit 0
}

if (Test-Port $port) {
  $v = Invoke-RestMethod "http://127.0.0.1:$port/json/version"
  Write-Output "AF-EDGE ALREADY RUNNING: $($v.Browser) on :$port"
  exit 0
}

$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Write-Output 'AF-EDGE ERROR: msedge.exe not found'; exit 1 }

New-Item -ItemType Directory -Force -Path $udd | Out-Null
Start-Process $edge -ArgumentList @(
  "--remote-debugging-port=$port",
  "--user-data-dir=$udd",
  '--no-first-run',
  '--no-default-browser-check',
  '--proxy-bypass-list=<local>;127.0.0.1;localhost',
  'about:blank'
)

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Port $port) {
    $v = Invoke-RestMethod "http://127.0.0.1:$port/json/version"
    Write-Output "AF-EDGE READY: $($v.Browser) on :$port (profile: $udd)"
    exit 0
  }
}
Write-Output 'AF-EDGE ERROR: debug port did not come up in 15s'
exit 1
