@echo off
setlocal enabledelayedexpansion
title Circle to Search
echo ================================================
echo        Circle to Search for Windows
echo ================================================
echo.

:: Detect Python executable
set "PYTHON_EXE="

:: 1. Check if 'python' in PATH works
python --version >nul 2>&1
if !errorlevel! equ 0 (
    set "PYTHON_EXE=python"
    goto :found_python
)

:: 2. Check if 'py' launcher works
py -3 --version >nul 2>&1
if !errorlevel! equ 0 (
    set "PYTHON_EXE=py -3"
    goto :found_python
)

:: 3. Check common AppData Python locations
if exist "%LOCALAPPDATA%\Programs\Python\Python314\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python314\python.exe"
    goto :found_python
)
if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    goto :found_python
)
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    goto :found_python
)
if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    goto :found_python
)

echo [ERROR] Python not detected!
echo Please install Python 3.10+ and ensure "Add Python to PATH" is checked.
echo Visit: https://www.python.org/downloads/
pause
exit /b 1

:found_python
echo [CircleToSearch] Using Python: !PYTHON_EXE!
echo [CircleToSearch] Starting background service...
echo.

!PYTHON_EXE! "%~dp0main.py"

if !errorlevel! neq 0 (
    echo.
    echo [CircleToSearch] Application closed with code !errorlevel!.
    pause
)
