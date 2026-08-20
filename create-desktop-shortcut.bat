@echo off
title MusicFlow - Create Desktop Shortcut
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"

if errorlevel 1 (
  echo.
  echo Something went wrong. The message above should say what.
)

echo.
pause
