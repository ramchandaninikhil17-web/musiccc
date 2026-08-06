# 🚀 Getting Started with MusicFlow

Welcome to **MusicFlow**! Follow this simple guide to get MusicFlow running on any computer, phone, or tablet in less than 2 minutes.

---

## ⚡ 1-Minute Quick Start (Windows PC)

### Step 1: Install Node.js (Only if you don't have it)
1. Download the free **LTS version** of Node.js from: **[https://nodejs.org/](https://nodejs.org/)**
2. Run the installer and click **Next** until finished.

---

### Step 2: Extract & Run MusicFlow
1. **Unzip** the downloaded MusicFlow folder anywhere on your computer (e.g. Desktop, Downloads, Documents).
2. Choose **ONE** of these ways to launch:

| Method | What to Double-Click | Best For |
| :--- | :--- | :--- |
| 🟢 **Method A (Recommended)** | **`start.bat`** | 1-Click universal launcher. Checks Node.js, installs dependencies on first run, and opens the app in your browser. |
| 🚀 **Method B (App Mode)** | **`MusicFlow.exe`** | Opens MusicFlow in a sleek desktop app window without browser tabs or address bars. |
| 🖥️ **Method C (Desktop Icon)** | **`create-desktop-shortcut.bat`** | Creates a **MusicFlow** icon directly on your Windows Desktop! |

> 💡 **First Run Note**: On the very first launch, the launcher will automatically install necessary packages (`npm install`) and fetch the background audio engine. This takes ~10-20 seconds. Future launches are instant!

---

## 🍏 macOS & Linux Quick Start

1. Install **Node.js** from [https://nodejs.org/](https://nodejs.org/) (or `brew install node`).
2. Open Terminal in the extracted `musicflow` folder.
3. Make the start script executable and run it:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```
4. MusicFlow will install dependencies on first run and automatically open in your default browser at `http://localhost:3000`.

---

## 📱 How to Use on Your Phone / Tablet (Same Wi-Fi)

You can use MusicFlow on your iPhone, iPad, Android phone, or Smart TV connected to your home Wi-Fi:

1. Start MusicFlow on your computer.
2. In MusicFlow, click the **📱 Phone** icon in the sidebar or top bar.
3. A modal will pop up with your computer's local Wi-Fi address (e.g. `http://192.168.1.15:3000`) and a **QR code**.
4. **Scan the QR code** with your phone's camera:
   - **Android (Chrome)**: Tap **⋮ Menu** (top right) → **"Install app"** or **"Add to Home screen"**.
   - **iPhone (Safari)**: Tap the **Share** button → **"Add to Home Screen"**.
5. 🎉 You now have MusicFlow on your phone with background audio, lock screen media controls, and lyrics!

---

## 🛠️ Advanced: Running via Terminal

If you prefer standard npm commands:

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

Then open **[http://localhost:3000](http://localhost:3000)** in any modern web browser.

---

## ❓ Frequently Asked Questions & Troubleshooting

<details>
<summary><strong>1. "Node.js is not recognized as an internal or external command"</strong></summary>

- Make sure you downloaded and installed Node.js from [nodejs.org](https://nodejs.org/).
- If you just installed Node.js, close and re-open your terminal or restart your computer so Windows updates your system PATH.
</details>

<details>
<summary><strong>2. "Port 3000 is already in use"</strong></summary>

- You can specify a custom port by setting the `PORT` environment variable before starting:
  - **Windows (Command Prompt)**: `set PORT=3001 && node server.js`
  - **Windows (PowerShell)**: `$env:PORT=3001; node server.js`
  - **Mac / Linux**: `PORT=3001 ./start.sh`
</details>

<details>
<summary><strong>3. Phone cannot connect to the PC's Wi-Fi link</strong></summary>

- Ensure both your PC and phone are connected to the **same Wi-Fi router**.
- If Windows Firewall blocks incoming connections, allow Node.js through Windows Defender Firewall (Private Networks).
</details>

---

Enjoy streaming your music with MusicFlow! 🎧✨
