@echo off
title MusicFlow
cd /d "%~dp0"
echo.
echo  ========================================
echo    🎵  Starting MusicFlow...
echo  ========================================
echo.
start "" "http://localhost:3000"
node server.js
pause