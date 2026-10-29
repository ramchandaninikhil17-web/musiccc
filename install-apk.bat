@echo off
title MusicFlow Standalone APK Installer
color 0a

echo.
echo ========================================================
echo   MusicFlow Standalone APK (100%% Phone Native - No PC Needed)
echo ========================================================
echo.

set "TARGET_APK=%~dp0MusicFlow.apk"
if not exist "%TARGET_APK%" (
    if exist "%~dp0mobile\android-apk-lite\apk-output\MusicFlow.apk" (
        set "TARGET_APK=%~dp0mobile\android-apk-lite\apk-output\MusicFlow.apk"
    )
)

echo   APK File: %TARGET_APK%
for %%A in ("%TARGET_APK%") do echo   Size:     %%~zA bytes
echo.

set ADB_PATH=
if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" (
    set "ADB_PATH=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
) else (
    where adb >nul 2>&1
    if %ERRORLEVEL% equ 0 set "ADB_PATH=adb"
)

if not "%ADB_PATH%"=="" (
    echo Checking for connected Android phone via USB...
    "%ADB_PATH%" devices
    echo.
    echo Attempting to install APK directly to phone...
    "%ADB_PATH%" install -r "%TARGET_APK%"
    if %ERRORLEVEL% equ 0 (
        echo.
        echo [SUCCESS] MusicFlow installed on your phone!
        echo You can now open MusicFlow from your phone's app drawer.
        goto :done
    )
)

echo.
echo --------------------------------------------------------
echo How to install on your phone manually:
echo --------------------------------------------------------
echo 1. Connect your phone with USB or send MusicFlow.apk to your phone
echo    (via WhatsApp, Google Drive, Bluetooth, or USB File Transfer).
echo 2. Tap on MusicFlow.apk on your phone to Install.
echo 3. Open MusicFlow and enjoy! Works directly on Mobile Data or Wi-Fi.
echo --------------------------------------------------------

:done
echo.
pause
