#!/usr/bin/env bash
# ============================================================
#   🎵 MusicFlow Startup Script (macOS / Linux)
# ============================================================

cd "$(dirname "$0")"

echo "============================================================"
echo "  🎵  Starting MusicFlow..."
echo "============================================================"
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
if command -v xdg-open &> /dev/null; then
    xdg-open "http://localhost:3000" &
elif command -v open &> /dev/null; then
    open "http://localhost:3000" &
fi

# 4. Start Server
echo "[INFO] Starting MusicFlow backend server..."
node server.js
