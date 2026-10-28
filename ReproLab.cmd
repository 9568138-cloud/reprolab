@echo off
rem ReproLab one-click launcher -- double click this file.
rem Starts the local server in background and opens your browser.
rem Needs Node.js 20+ (https://nodejs.org).
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ReproLab] Node.js not found.
  echo   Install Node.js 20 or newer from https://nodejs.org
  echo   then double click this file again.
  echo.
  pause
  exit /b 1
)
node "%~dp0start.mjs" %*
if errorlevel 1 (
  echo.
  echo   [ReproLab] Failed to start. Check serve.log in this folder.
  echo.
  pause
  exit /b 1
)
rem give the browser a moment, then close this window
ping -n 2 127.0.0.1 >nul
exit /b 0
