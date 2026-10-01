# SyncWave 🌊

A desktop media app built with React and Electron: download YouTube video and music in studio quality, and trim local audio/video files frame-accurately.

Website: https://mo-alhamouri.github.io/SyncWave/

## ✨ Features

- **YouTube Engine**: 1080p / 720p MP4 and 320kbps MP3, including playlists. MP4s use YouTube's native H.264 streams (no re-encoding), with hardware-accelerated conversion as a fallback.
- **Clip Trimmer**: precise trimming of local audio and video files.
- **Self-maintaining engine**: yt-dlp updates itself on every launch and automatically retries with the newest build if YouTube blocks a download.
- **In-app updates**: the *Update* button downloads and installs new SyncWave releases (v1.2.8+).

## 📦 Installing on macOS

Easiest (no Gatekeeper prompts):

```bash
curl -fsSL https://mo-alhamouri.github.io/SyncWave/install.sh | bash
```

Or download the `.dmg` from the website, drag SyncWave to Applications, open it once, then go to **System Settings › Privacy & Security › Open Anyway**.

SyncWave is ad-hoc signed, not signed with a paid Apple Developer ID, which is why macOS asks for approval the first time.

## 🚀 Development

```bash
npm run setup   # install root + frontend dependencies
npm run dev     # Vite dev server + Electron
```

Project layout:

- `electron/main.js`: app window and IPC
- `electron/engine.js`: yt-dlp / Deno / FFmpeg management (auto-update + retry)
- `electron/updater.js`: in-app updater (GitHub Releases)
- `frontend/`: React UI (Vite)
- `Marketing Website/`: the GitHub Pages site and `install.sh`
- `scripts/adhoc-sign.js`: macOS ad-hoc signing hook for electron-builder

## 🏷 Releasing

1. Bump `version` in `package.json` (for example, `1.2.9`) and commit.
2. Tag and push: `git tag v1.2.9 && git push origin main --tags`
3. GitHub Actions (`.github/workflows/release.yml`) builds macOS (Intel + Apple Silicon) and Windows and publishes the release. Installed apps pick it up through **Update**.

Website changes under `Marketing Website/` deploy automatically on push to `main` (`pages.yml`).

## 🛠 Tech Stack

Electron, React 19, Vite, yt-dlp, Deno (for YouTube's JS challenges), FFmpeg.

## 📜 License

MIT
