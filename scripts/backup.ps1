<#
  Mirrors the CityTwin project to the backup drive and dumps the database next to it.

  Skips what can be rebuilt: node_modules (npm install), dist (npm run build), logs, caches
  and backend/.pg (the PostgreSQL/PostGIS binaries, ~2 GB; re-extract them as in the README).
  The database itself is saved as backup/citytwin.dump (pg_dump custom format) when it is running;
  restore with: pg_restore -h 127.0.0.1 -p 54329 -U postgres -d citytwin --clean citytwin.dump

  robocopy /MIR makes the copy match the project, so files deleted here are deleted there too.
  -Quiet suppresses the MessageBox (used by CityTwin-Stop.ps1).
#>
param(
  [string]$Dest = 'D:\Claude_Yedek_2026-10-28\Claude_Code_Projeleri\CityTwin',
  [switch]$Quiet
)
$ErrorActionPreference = 'Continue'
$Root = Split-Path $PSScriptRoot -Parent
$Bin = Join-Path $Root 'backend\.pg\pgsql\bin'

function Done([string]$msg, [string]$icon) {
  if ($Quiet) { Write-Output $msg; return }
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($msg, 'CityTwin backup', 'OK', $icon) | Out-Null
}

$drive = Split-Path $Dest -Qualifier
if (-not (Test-Path "$drive\")) { Done "Backup drive $drive is not connected; nothing was copied." 'Warning'; exit 1 }

$src = Join-Path $Dest 'citytwin'
New-Item -ItemType Directory -Force $src | Out-Null
robocopy $Root $src /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP `
  /XD node_modules dist logs .pg __pycache__ .pytest_cache .ruff_cache .mypy_cache .vite `
  /XF *.pyc tsconfig.tsbuildinfo | Out-Null
$copyOk = $LASTEXITCODE -lt 8   # robocopy: 0-7 success, 8+ failure

$dump = 'not running, skipped'
& "$Bin\pg_isready.exe" -h 127.0.0.1 -p 54329 -q
if ($LASTEXITCODE -eq 0) {
  New-Item -ItemType Directory -Force (Join-Path $Dest 'backup') | Out-Null
  $tmp = Join-Path $Dest 'backup\citytwin.dump.part'
  & "$Bin\pg_dump.exe" -h 127.0.0.1 -p 54329 -U postgres -Fc -f $tmp citytwin
  if ($LASTEXITCODE -eq 0) { Move-Item -Force $tmp (Join-Path $Dest 'backup\citytwin.dump'); $dump = 'saved' }
  else { Remove-Item -Force $tmp -ErrorAction SilentlyContinue; $dump = 'FAILED' }
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
Set-Content -Encoding UTF8 (Join-Path $Dest 'SON_YEDEK.txt') @"
CityTwin yedeği — $stamp
Kaynak: $Root
citytwin\        proje dosyaları (node_modules, dist, backend\.pg hariç)
backup\citytwin.dump  veritabanı ($dump)

Geri yükleme: citytwin klasörünü kopyala, 'npm install' çalıştır, README'deki gibi backend\.pg'yi kur,
sonra: pg_restore -h 127.0.0.1 -p 54329 -U postgres -d citytwin --clean backup\citytwin.dump
"@

if ($copyOk -and $dump -ne 'FAILED') { Done "CityTwin backed up to $Dest ($stamp). Database: $dump." 'Information' }
else { Done "Backup finished with errors (files ok: $copyOk, database: $dump)." 'Warning'; exit 1 }
