#!/usr/bin/env bash
# MusicFlow Root Gradle Wrapper Forwarder
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR/mobile/android-apk-lite"
./gradlew "$@"
EXIT_CODE=$?
cd "$DIR"
exit $EXIT_CODE

