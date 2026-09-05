@echo off
setlocal
title MusicFlow - Restart
cd /d "%~dp0"

echo ============================================================
echo   Restarting MusicFlow (loads the latest video-download fix)
echo ============================================================
echo.

echo [1/3] Stopping any MusicFlow app window...
taskkill /IM MusicFlow.exe /F >nul 2>nul

echo [2/3] Stopping the old server process (this is what still made MP3)...
REM Kill any node process serving MusicFlow. We match on the server.js path so we
REM don't disturb unrelated node apps the user may be running.
for /f "tokens=2 delims=," %%P in ('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2^>nul') do (
    taskkill /PID %%~P /F >nul 2>nul
)

REM Give sockets a moment to release so the new server can grab the port.
timeout /t 2 /nobreak >nul

echo [3/3] Starting MusicFlow fresh...
if exist "MusicFlow.exe" (
    start "" "%~dp0MusicFlow.exe"
) else (
    start "" cmd /c "node server.js"
)

echo.
echo Done. When MusicFlow opens, pick MP4 and your chosen resolution -
echo the download will now be a real video.
echo.
timeout /t 4 /nobreak >nul
exit /b 0
