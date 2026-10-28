<#
  CityTwin desktop launcher (used by the desktop shortcut).

  Starts the local PostgreSQL/PostGIS cluster and the CityTwin API (which also serves the
  built frontend from dist/), waits until /api/v1/health answers, then opens the app in an
  Edge app window. Already-running parts are reused, so double-clicking twice is harmless.
  CityTwin-Stop.ps1 shuts both servers down again.

  Python: $env:CITYTWIN_PYTHON, else the Miniforge env "citytwin".
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Url = 'http://localhost:8000'
$Health = 'http://127.0.0.1:8000/api/v1/health'
$Python = if ($env:CITYTWIN_PYTHON) { $env:CITYTWIN_PYTHON } else { Join-Path $env:USERPROFILE 'miniforge3\envs\citytwin\python.exe' }
$Logs = Join-Path $Root 'logs'

Add-Type -AssemblyName System.Windows.Forms
function Fail([string]$msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, 'CityTwin', 'OK', 'Error') | Out-Null
  exit 1
}

function Test-Api {
  try {
    $h = Invoke-RestMethod $Health -TimeoutSec 2
    return [bool]$h.ok
  } catch { return $false }
}

if (-not (Test-Path (Join-Path $Root 'dist\index.html'))) { Fail "The frontend isn't built yet.`nRun 'npm run build' in $Root first." }
if (-not (Test-Path $Python)) { Fail "Python environment not found:`n$Python`n`nSet CITYTWIN_PYTHON to the python.exe that has the backend installed." }

try {
  & (Join-Path $Root 'backend\scripts\db.ps1') start | Out-Null
} catch {
  Fail "PostgreSQL could not be started:`n$($_.Exception.Message)`n`nSee backend\.pg\server.log"
}

if (-not (Test-Api)) {
  New-Item -ItemType Directory -Force $Logs | Out-Null
  Start-Process -FilePath $Python -WindowStyle Hidden -WorkingDirectory $Root `
    -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--app-dir', "`"$(Join-Path $Root 'backend')`"", '--host', '127.0.0.1', '--port', '8000') `
    -RedirectStandardOutput (Join-Path $Logs 'api.out.log') -RedirectStandardError (Join-Path $Logs 'api.log')
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Api)) {
    if ((Get-Date) -gt $deadline) { Fail "The CityTwin API did not start within 60 s.`nSee $(Join-Path $Logs 'api.log')" }
    Start-Sleep -Milliseconds 500
  }
}

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) {
  Start-Process $edge -ArgumentList @("--app=$Url", '--window-size=1500,920')
} else {
  Start-Process $Url
}
