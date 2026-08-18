@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-origin-egress.ps1"
if errorlevel 1 (
  echo Origin egress failed.
  pause
  exit /b 1
)
echo Origin egress is up. You can close this window.
pause
