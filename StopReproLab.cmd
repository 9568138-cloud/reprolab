@echo off
rem Stop the background ReproLab server (frees port 5173).
setlocal
set PORT=5173
if not "%~1"=="" set PORT=%~1
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; Write-Host ('stopped: port %PORT%') } else { Write-Host ('nothing is listening on port %PORT%') }"
ping -n 3 127.0.0.1 >nul
exit /b 0
