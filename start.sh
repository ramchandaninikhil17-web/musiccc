#!/usr/bin/env bash
# ============================================================
#   🎵 MusicFlow v2.5 Startup Script (macOS / Linux)
# ============================================================

cd "$(dirname "$0")"

echo "============================================================"
echo "  🎵  MusicFlow v2.5 — Premium Music Player"
echo "============================================================"
echo ""
echo "  ✨ NEW in this update:"
echo "    🍏 Apple Transparent Floating Orb & Dynamic Island"
echo "    🖼️  Always-On-Top PiP Mini-Player for Multitasking"
echo "    ⏱️  Pomodoro Focus Flow & Ambient Sound Mixer"
echo "    🌐 MediaSession Lockscreen & Global Hotkeys"
echo "    ☁️  1-Click Cloud Deploy (Render / Railway / Docker)"
echo ""

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed or not in PATH!"
    echo "Please download and install Node.js (LTS version) from: https://nodejs.org/"
    exit 1
fi

# 2. Check if node_modules exists, if not install
if [ ! -d "node_modules" ]; then
    echo "[INFO] First time setup: Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[ERROR] npm install encountered an error."
        exit 1
    fi
    echo "[SUCCESS] Dependencies installed successfully!"
    echo ""
fi

# 3. Open browser
echo "[INFO] Opening MusicFlow in your browser..."
if command -v xdg-open &> /dev/null; then
    xdg-open "http://localhost:3000" &
elif command -v open &> /dev/null; then
    open "http://localhost:3000" &
fi

# 4. Start Server
echo "[INFO] Starting MusicFlow backend server on port 3000..."
echo ""
echo "============================================================"
echo "  Keyboard Shortcuts (when app is focused):"
echo "    Space       Play / Pause"
echo "    P           Always-On-Top PiP Mini Player"
echo "    Shift+P     Previous Track"
echo "    N           Next Track"
echo "    F           Open Pomodoro Focus Mode"
echo "    M           Mute / Unmute"
echo "    D           Download MP3"
echo "    L           Toggle Lyrics"
echo "    Q           Toggle Queue"
echo "    Arrows      Seek / Volume"
echo "============================================================"
echo ""
node server.js
