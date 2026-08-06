@echo off
setlocal enabledelayedexpansion
title MusicFlow — Music Player
cd /d "%~dp0"

echo ============================================================
echo   🎵  Starting MusicFlow Player...
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
    echo Once installed, double-click start.bat again!
    echo.
    start "" "https://nodejs.org/"
    pause
    exit /b 1
)

:: 2. Check if node_modules exists, if not install automatically
if not exist "node_modules\" (
    echo [INFO] First time setup detected. Installing dependencies...
    echo Please wait a moment (this only happens on first run)...
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

:: 3. Launch browser / app
start "" "http://localhost:3000"

:: 4. Start Server
echo [INFO] Starting MusicFlow backend server...
node server.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] MusicFlow server stopped.
    pause
)