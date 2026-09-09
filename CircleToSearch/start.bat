@echo off
title Circle to Search
echo ======================================
echo   Circle to Search - Starting...
echo ======================================
echo.

:: Check Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not in PATH.
    echo Install Python from https://python.org
    pause
    exit /b 1
)

:: Run the app
echo Press Win+Shift+Q to activate Circle to Search.
echo Press Ctrl+C or close this window to exit.
echo.
python "%~dp0main.py"

if %errorlevel% neq 0 (
    echo.
    echo Application exited with an error.
    pause
)
