@echo off
title Create MusicFlow Shortcut
cd /d "%~dp0"

echo ===================================================
echo   Creating MusicFlow Desktop Shortcut...
echo ===================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"

echo.
pause
