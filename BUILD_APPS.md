# 💻 MusicFlow — Desktop & Cloud Application Guide

**MusicFlow** is built for high-performance desktop music streaming and cloud deployment across Windows, macOS, Linux, and web browsers.

---

## 💻 1. Windows Desktop App Mode

- **Double-click `MusicFlow.exe`**: Starts the backend server and opens MusicFlow in a sleek, distraction-free app window.
- **Double-click `create-desktop-shortcut.bat`**: Instantly creates a desktop shortcut (`MusicFlow.lnk`) for 1-click access anytime.
- **Double-click `start.bat`**: Automated setup batch script with Node.js check and dependency installer.

---

## 🍏 2. macOS & Linux Setup

1. Open Terminal in the `musiccc` directory.
2. Grant execution permission and launch:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```
3. MusicFlow will verify dependencies and launch in your default browser.

---

## ☁️ 3. Cloud Deployment (Render, Railway, Docker, Vercel)

MusicFlow can be hosted 24/7 on cloud platforms:
- **Render / Railway**: Pre-configured using `render.yaml` and `railway.json`.
- **Docker**: Build and run with `docker build -t musicflow . && docker run -p 3000:3000 musicflow`.
- **Node Server**: Run `npm start` on any VPS or cloud instance.
