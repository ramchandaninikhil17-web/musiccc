@echo off
REM MusicFlow Root Gradle Wrapper Forwarder
cd "%~dp0mobile\android-apk-lite"
call gradlew.bat %*
set EXIT_CODE=%ERRORLEVEL%
cd "%~dp0"
exit /b %EXIT_CODE%
