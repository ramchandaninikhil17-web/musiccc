@echo off
setlocal enabledelayedexpansion
title MusicFlow — Music Player v2.5
cd /d "%~dp0"

echo ============================================================
echo   🎵  MusicFlow v2.5 — Premium Music Player
echo ============================================================
echo.
echo   ✨ NEW in this update:
echo     🍏 Apple Transparent Floating Orb ^& Dynamic Island
echo     🖼️  Always-On-Top PiP Mini-Player for Multitasking
echo     ⏱️  Pomodoro Focus Flow ^& Ambient Sound Mixer
echo     🌐 MediaSession Lockscreen ^& Global Hotkeys
echo     ☁️  1-Click Cloud Deploy (Render / Railway / Docker)
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
echo [INFO] Opening MusicFlow in your browser...
start "" "http://localhost:3000"

:: 4. Start Server
echo [INFO] Starting MusicFlow backend server on port 3000...
echo.
echo ============================================================
echo   Keyboard Shortcuts (when app is focused):
echo     Space       Play / Pause
echo     P           Always-On-Top PiP Mini Player
echo     Shift+P     Previous Track
echo     N           Next Track
echo     F           Open Pomodoro Focus Mode
echo     M           Mute / Unmute
echo     D           Download MP3
echo     L           Toggle Lyrics
echo     Q           Toggle Queue
echo     Arrows      Seek / Volume
echo ============================================================
echo.
node server.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] MusicFlow server stopped.
    pause
)