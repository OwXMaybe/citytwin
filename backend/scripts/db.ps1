<#
  Local PostgreSQL 17 + PostGIS for CityTwin development — no installer, no admin.

    pwsh backend/scripts/db.ps1 setup    # download (official zips) + initdb + create role/db + postgis
    pwsh backend/scripts/db.ps1 start
    pwsh backend/scripts/db.ps1 stop
    pwsh backend/scripts/db.ps1 status

  Everything lives in backend/.pg (git-ignored). Delete that folder to remove it completely.
  Server: 127.0.0.1:54329, database "citytwin", role "citytwin" (trust auth on localhost only).
#>
param([Parameter(Mandatory)][ValidateSet('setup', 'start', 'stop', 'status')] [string]$Command)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$Pg = Join-Path $Root '.pg'
$Bin = Join-Path $Pg 'pgsql\bin'
$Data = Join-Path $Pg 'data'
$Log = Join-Path $Pg 'server.log'
$Port = 54329

$PgZip = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip'
$PostgisZip = 'https://download.osgeo.org/postgis/windows/pg17/postgis-bundle-pg17-3.6.2x64.zip'

function Install-Binaries {
  if (Test-Path (Join-Path $Bin 'postgres.exe')) { return }
  $dl = Join-Path $Pg '_downloads'
  New-Item -ItemType Directory -Force $dl | Out-Null
  if (-not (Test-Path "$dl\pg17.zip")) { Invoke-WebRequest $PgZip -OutFile "$dl\pg17.zip" }
  if (-not (Test-Path "$dl\postgis.zip")) { Invoke-WebRequest $PostgisZip -OutFile "$dl\postgis.zip" }
  Expand-Archive "$dl\pg17.zip" -DestinationPath "$dl\pg" -Force
  Expand-Archive "$dl\postgis.zip" -DestinationPath "$dl\postgis" -Force
  Move-Item "$dl\pg\pgsql" (Join-Path $Pg 'pgsql')
  # The PostGIS bundle mirrors the PostgreSQL install layout: overlay bin/lib/share.
  $bundle = Get-ChildItem "$dl\postgis" -Directory | Select-Object -First 1
  foreach ($d in 'bin', 'lib', 'share', 'gdal-data', 'utils') {
    $src = Join-Path $bundle.FullName $d
    if (Test-Path $src) { Copy-Item "$src\*" (Join-Path $Pg "pgsql\$d") -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Test-Path (Join-Path $Pg "pgsql\$d"))) { Copy-Item $src (Join-Path $Pg "pgsql\$d") -Recurse } }
  }
}

function Start-Db {
  & "$Bin\pg_ctl.exe" -D $Data status *> $null
  if ($LASTEXITCODE -eq 0) { Write-Host "already running on $Port"; return }
  # Launch detached: the postmaster would otherwise inherit this shell's output pipe and
  # keep the calling pipeline open forever. Wait on pg_ctl only: Windows PowerShell 5.1's
  # Start-Process -Wait also waits for descendants, i.e. for the server to exit.
  $p = Start-Process -FilePath "$Bin\pg_ctl.exe" -ArgumentList @('-D', "`"$Data`"", '-l', "`"$Log`"", '-o', "`"-p $Port -c listen_addresses=127.0.0.1`"", '-w', 'start') -WindowStyle Hidden -PassThru
  $p.WaitForExit()
  Write-Host "PostgreSQL started on 127.0.0.1:$Port (log: $Log)"
}

switch ($Command) {
  'setup' {
    Install-Binaries
    if (-not (Test-Path (Join-Path $Data 'PG_VERSION'))) {
      & "$Bin\initdb.exe" -D $Data -U postgres -A trust -E UTF8 --locale=C | Out-Null
    }
    Start-Db
    & "$Bin\psql.exe" -h 127.0.0.1 -p $Port -U postgres -v ON_ERROR_STOP=1 -q -c "DO `$`$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='citytwin') THEN CREATE ROLE citytwin LOGIN; END IF; END`$`$;"
    $exists = & "$Bin\psql.exe" -h 127.0.0.1 -p $Port -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='citytwin'"
    if ($exists -ne '1') { & "$Bin\createdb.exe" -h 127.0.0.1 -p $Port -U postgres -O citytwin citytwin }
    & "$Bin\psql.exe" -h 127.0.0.1 -p $Port -U postgres -d citytwin -q -c 'CREATE EXTENSION IF NOT EXISTS postgis;'
    & "$Bin\psql.exe" -h 127.0.0.1 -p $Port -U postgres -d citytwin -tAc 'SELECT postgis_full_version();'
  }
  'start' { Start-Db }
  'stop' { & "$Bin\pg_ctl.exe" -D $Data -w stop -m fast }
  'status' { & "$Bin\pg_ctl.exe" -D $Data status }
}
