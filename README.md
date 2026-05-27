# SyncWave Downloader 🌊

A modern, high-performance YouTube downloader that supports single videos and entire playlists. Built with a beautiful glassmorphic UI and powered by `yt-dlp`.

## ✨ Features

- **Playlist Support**: Effortlessly download entire playlists with a single link.
- **Smart Queue Management**:
    - Automatic sequential downloads.
    - **Dynamic Selection**: Unselect pending items in the queue to skip them.
    - **Stop/Cancel**: Abort the entire download process at any time.
- **High Quality**: Extract best quality MP3 audio or MP4 video (up to 1080p).
- **Responsive UI**: Modern, dark-mode design with interactive progress tracking.
- **Automatic Cleanup**: Temporary files are automatically managed to save disk space.

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher)
- [FFmpeg](https://ffmpeg.org/) (automatically installed via package, but system install recommended for production)

### Local Setup
1. **Clone and Setup**:
   ```bash
   npm run setup
   ```
2. **Run in Development**:
   ```bash
   npm run dev
   ```
   - Frontend: `http://localhost:5173`
   - Backend: `http://localhost:5001`

## 📦 Deployment

This project is production-ready and configured for one-click deployment on platforms like **Railway** or **Render**.

1. **Build the frontend**:
   ```bash
   cd frontend && npm run build
   ```
2. **Start the production server**:
   ```bash
   cd backend && npm start
   ```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed hosting instructions.

## 🛠 Tech Stack
- **Frontend**: React 19, Vite, Tailwind-inspired CSS.
- **Backend**: Node.js, Express, Server-Sent Events (SSE).
- **Engine**: yt-dlp, FFmpeg.

## 📜 License
MIT
