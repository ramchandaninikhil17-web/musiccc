@echo off
REM -------------------------------------------------------
REM  build.bat — Build MusicFlow APK
REM  Usage: build.bat [debug|release]
REM  Default: debug
REM -------------------------------------------------------

set BUILD_TYPE=%1
if "%BUILD_TYPE%"=="" set BUILD_TYPE=debug

echo.
echo =======================================================
echo   Building MusicFlow APK (%BUILD_TYPE%)
echo =======================================================
echo.

REM Prioritize Android Studio's bundled JBR, then JDK 21 LTS, then JAVA_HOME
if exist "C:\Program Files\Android\Android Studio\jbr\bin\java.exe" (
    set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
) else if exist "C:\Program Files\Java\jdk-21.0.12.1\bin\java.exe" (
    set "JAVA_HOME=C:\Program Files\Java\jdk-21.0.12.1"
) else if exist "C:\Program Files\Java\jdk-21\bin\java.exe" (
    set "JAVA_HOME=C:\Program Files\Java\jdk-21"
) else if exist "C:\Program Files\Java\jdk-17\bin\java.exe" (
    set "JAVA_HOME=C:\Program Files\Java\jdk-17"
)

if not "%JAVA_HOME%"=="" (
    echo Using JAVA_HOME: %JAVA_HOME%
)

if not exist apk-output mkdir apk-output

if "%BUILD_TYPE%"=="release" (
    call gradlew.bat assembleRelease
    if %ERRORLEVEL% neq 0 goto :error
    copy /Y app\build\outputs\apk\release\app-release.apk apk-output\MusicFlow.apk
    copy /Y app\build\outputs\apk\release\app-release.apk apk-output\MusicFlow-release.apk
) else (
    call gradlew.bat assembleDebug
    if %ERRORLEVEL% neq 0 goto :error
    copy /Y app\build\outputs\apk\debug\app-debug.apk apk-output\MusicFlow.apk
    copy /Y app\build\outputs\apk\debug\app-debug.apk apk-output\MusicFlow-debug.apk
)

echo.
echo =======================================================
echo   APK built successfully!
echo   Location: apk-output\MusicFlow.apk
for %%A in (apk-output\MusicFlow.apk) do echo   Size: %%~zA bytes
echo =======================================================
echo.
echo To install onto your connected phone:
echo   adb install -r apk-output\MusicFlow.apk
echo.
goto :end

:error
echo.
echo =======================================================
echo   BUILD FAILED
echo =======================================================
exit /b 1

:end
