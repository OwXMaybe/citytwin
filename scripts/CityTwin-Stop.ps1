<#
  Stops what CityTwin.ps1 started: the CityTwin API (uvicorn on port 8000) and the local
  PostgreSQL cluster, after refreshing the backup copy (backup.ps1). The browser window can simply be closed.
#>
$ErrorActionPreference = 'Continue'
$Root = Split-Path $PSScriptRoot -Parent

Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
  Where-Object { $_.CommandLine -match 'uvicorn' -and $_.CommandLine -match 'app\.main:app' -and $_.CommandLine -match '--port\s+8000' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Refresh the backup-drive copy while the database is still up (skipped if the drive is absent).
$backup = (& (Join-Path $PSScriptRoot 'backup.ps1') -Quiet) -join ' '

& (Join-Path $Root 'backend\scripts\db.ps1') stop | Out-Null

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show("CityTwin stopped (API and database).`n`n$backup", 'CityTwin', 'OK', 'Information') | Out-Null
