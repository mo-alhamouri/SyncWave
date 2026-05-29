# SyncWave Downloader 🌊

A modern, high-performance **Desktop Application** for downloading YouTube videos and entire playlists. Built with React and Electron, powered by `yt-dlp`.

## ✨ Why Desktop?

- **No More Throttling**: By running locally, you use your own home IP, bypassing the "Too Many Requests" (429) errors common on web-based hosters.
- **Privacy First**: No video data ever touches a third-party server.
- **Fast & Reliable**: Direct downloads from YouTube to your machine.

## ✨ Features

- **Playlist Support**: Effortlessly download entire playlists with a single link.
- **Smart Queue Management**:
    - Automatic sequential downloads.
    - **Dynamic Selection**: Unselect pending items in the queue to skip them.
    - **Stop/Cancel**: Abort the entire download process at any time.
- **High Quality**: Extract best quality MP3 audio or MP4 video (up to 1080p).
- **Responsive UI**: Modern, dark-mode design with interactive progress tracking.
- **Open Downloads**: One-click access to your downloaded files.

## 🚀 Getting Started

### Installation
*Installers for Mac and Windows coming soon to our official website!*

### Local Development
1. **Clone and Setup**:
   ```bash
   npm run setup
   ```
2. **Run the App**:
   ```bash
   npm run dev
   ```

## 🛠 Tech Stack
- **Desktop**: Electron.
- **Frontend**: React 19, Vite.
- **Engine**: yt-dlp, FFmpeg.

## 📜 License
MIT
