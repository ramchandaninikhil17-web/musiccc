@echo off
REM ========================================================
REM  MusicFlow — Phone Connection & USB Reverse Tether
REM ========================================================
title MusicFlow Phone Connector
color 0b

echo.
echo ========================================================
echo   MusicFlow — Connect Android Phone to PC Localhost
echo ========================================================
echo.

REM 1. Display PC IP Addresses
echo [1] Your PC Wi-Fi / Local Network IP:
for /f "tokens=4" %%a in ('route print 0.0.0.0 ^| findstr 0.0.0.0 ^| findstr /v "0.0.0.0.*0.0.0.0"') do (
    echo     ==^> http://%%a:3000
)
echo.
echo     Open this URL on your phone browser or inside the MusicFlow APK!
echo.

REM 2. Check for ADB & USB Connection
echo [2] Checking USB Connection (adb reverse):
where adb >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo     ADB detected! Checking connected devices...
    adb devices
    echo.
    echo     Forwarding PC localhost:3000 to phone localhost:3000...
    adb reverse tcp:3000 tcp:3000
    if %ERRORLEVEL% equ 0 (
        echo     [SUCCESS] USB port forwarded!
        echo     You can now use http://127.0.0.1:3000 or http://localhost:3000 on your phone!
    ) else (
        echo     [INFO] No USB device connected. Use Wi-Fi connection above.
    )
) else (
    echo     [INFO] ADB is not in system PATH. For USB connection, ensure Android SDK platform-tools is installed.
)

echo.
echo ========================================================
echo   APK Build Shortcuts:
echo   - To build debug APK:   cd mobile\android-apk-lite ^&^& build.bat debug
echo   - To build release APK: cd mobile\android-apk-lite ^&^& build.bat release
echo ========================================================
echo.
pause
