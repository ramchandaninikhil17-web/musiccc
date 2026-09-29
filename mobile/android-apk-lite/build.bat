@echo off
REM -------------------------------------------------------
REM  build.bat — Build MusicFlow APK
REM  Usage: build.bat [debug|release]
REM  Default: debug
REM -------------------------------------------------------

set BUILD_TYPE=%1
if "%BUILD_TYPE%"=="" set BUILD_TYPE=debug

echo.
echo === Building MusicFlow APK (%BUILD_TYPE%) ===
echo.

REM Use JDK 17+ (prioritize JDK 21 LTS)
if exist "%APPDATA%\.minecraft\runtime\java-runtime-delta\windows\java-runtime-delta\bin\java.exe" (
    set JAVA_HOME=%APPDATA%\.minecraft\runtime\java-runtime-delta\windows\java-runtime-delta
) else if exist "C:\Program Files\Java\jdk-26.0.1" (
    set JAVA_HOME=C:\Program Files\Java\jdk-26.0.1
)

if "%BUILD_TYPE%"=="release" (
    call gradlew.bat assembleRelease
    if %ERRORLEVEL% neq 0 goto :error
    copy /Y app\build\outputs\apk\release\app-release.apk apk-output\MusicFlow.apk
) else (
    call gradlew.bat assembleDebug
    if %ERRORLEVEL% neq 0 goto :error
    copy /Y app\build\outputs\apk\debug\app-debug.apk apk-output\MusicFlow.apk
)

echo.
echo === APK built successfully! ===
echo Location: apk-output\MusicFlow.apk
for %%A in (apk-output\MusicFlow.apk) do echo Size: %%~zA bytes
echo.
echo To install: adb install apk-output\MusicFlow.apk
goto :end

:error
echo.
echo === BUILD FAILED ===
exit /b 1

:end
