@echo off
setlocal enabledelayedexpansion
title MusicFlow — Music Player v2.5
cd /d "%~dp0"

echo ============================================================
echo   🎵  MusicFlow v2.5 — Premium Music Player
echo ============================================================
echo.

:: 1. Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo.
    echo Please install Node.js (LTS version) from:
    echo   https://nodejs.org/
    echo.
    echo Once installed, launch MusicFlow again!
    echo.
    start "" "https://nodejs.org/"
    pause
    exit /b 1
)

:: 2. Check if node_modules exists, if not install automatically
if not exist "node_modules\" (
    echo [INFO] First time setup detected. Installing dependencies...
    echo Please wait a moment...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] npm install encountered an error.
        pause
        exit /b 1
    )
    echo.
    echo [SUCCESS] Setup complete!
    echo.
)

:: 3. Launch MusicFlow desktop app launcher
if exist "MusicFlow.exe" (
    echo [INFO] Launching MusicFlow Desktop App...
    start "" "%~dp0MusicFlow.exe"
    exit /b 0
)

:: Fallback direct node launch
echo [INFO] Starting MusicFlow server...
node server.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] MusicFlow server stopped.
    pause
)