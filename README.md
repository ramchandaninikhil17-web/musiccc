# 🎵 MusicFlow — High-Performance Web Music Streaming Player

**MusicFlow** is a modern, responsive web-based music application powered by Express.js and `yt-dlp`. It allows users to search, stream, download, and manage music playlists without requiring YouTube Data API keys or database setup.

---

## ✨ Features

- 📜 **Smart Batch Text Song Importer**:
  - Add multiple songs to new or existing playlists using raw text strings, space-separated names (e.g. `siyara keshariya akhari ishk blinglight starboy`), line breaks, or comma-separated lists.
  - Interactive tokenized chip editor to preview and refine detected song terms.

- 🏆 **Official Release Prioritization Engine**:
  - Smart scoring system that ranks search results based on view counts, track durations, and official record labels (**T-Series**, **Sony Music**, **YRF**, **Zee Music**, **Saregama**, **The Weeknd**, etc.).
  - Automatic filtering out of fan covers, ringtones, and slowed+reverb edits.

- 📻 **Personalized Home Recommendations & Radio**:
  - Dynamically builds custom music recommendations based on listening history and liked tracks.
  - One-click **Personalized Radio Mix** that generates an endless stream of music matching your taste.

- ⚡ **Database-Free & Ultra-Fast**:
  - Built entirely on `localStorage` for client state.
  - Features an in-memory LRU/TTL cache and concurrency control on the server to ensure fast performance.

- 📥 **Direct MP3 Downloading**:
  - Integrated high-speed MP3 audio download endpoint.

- 🎨 **Modern Dark Glassmorphism UI**:
  - Styled with CSS variables, smooth micro-animations, theme toggling (Dark/Light), responsive layouts, and lyrics synchronization.

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js, `yt-dlp`
- **Frontend**: Vanilla JavaScript (ES6+), HTML5, Custom CSS3
- **Storage**: `localStorage` (Zero external database required)

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) binary installed locally or placed in the project root directory.

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/musicflow.git
   cd musicflow
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the server**:
   ```bash
   npm start
   ```
   Or for development mode:
   ```bash
   npm run dev
   ```

4. Open your browser and navigate to:
   ```text
   http://localhost:3000
   ```

---

## 📁 Project Structure

```text
musiccc/
├── public/
│   ├── index.html        # Main SPA interface
│   ├── css/
│   │   └── style.css     # Glassmorphism design system & components
│   └── js/
│       └── app.js        # Single-page application logic & player state
├── server.js             # Express server, search scoring & streaming API
├── package.json          # Project metadata and dependencies
└── README.md             # Documentation
```

---

## 📄 License

This project is licensed under the MIT License.
