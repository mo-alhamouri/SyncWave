# SyncWave 🌊

A desktop media app built with React and Electron: download YouTube video and music in studio quality, trim local audio/video files on a visual waveform, and split songs into separate instrument tracks.

**Website & download:** [mo-alhamouri.github.io/SyncWave](https://mo-alhamouri.github.io/SyncWave/)

[![SyncWave](Marketing%20Website/og-image.png)](https://mo-alhamouri.github.io/SyncWave/)

## ✨ Features

- **YouTube Engine**: 1080p / 720p MP4 and 320kbps MP3. MP4s use YouTube's native H.264 streams (no re-encoding), with hardware-accelerated conversion as a fallback.
- **Clip Trimmer**: precise trimming of local audio and video files, with a real loudness waveform, a live playhead and drag & drop.
- **Vocal Remover & Stem Splitter**: split a song into vocals, drums, bass, guitar, piano and other instruments with on-device AI (nothing is uploaded). Mute/solo tracks while they play in sync, then save one track or your own mix as MP3 320 kbps. Two modes: **Fast** (Demucs) and **Best quality** (BS-RoFormer); each model downloads once on first use.
- **Self-maintaining engine**: yt-dlp updates itself on every launch and automatically retries with the newest build if YouTube blocks a download.
- **In-app updates**: the *Update* button downloads and installs new SyncWave releases (v1.2.10+).

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
- `electron/stems.js`, `stems-worker.js`, `stems-engine.js`: Vocal Remover (model downloads, separation in a background process, STFT/iSTFT + ONNX Runtime)
- `frontend/`: React UI (Vite)
- `Marketing Website/`: the GitHub Pages site and `install.sh`
- `scripts/adhoc-sign.js`: macOS ad-hoc signing hook for electron-builder

## 🏷 Releasing

1. Bump `version` in `package.json` (for example, `1.2.9`) and commit.
2. Tag and push: `git tag v1.2.9 && git push origin main --tags`
3. GitHub Actions (`.github/workflows/release.yml`) builds macOS (Intel + Apple Silicon) and Windows and publishes the release. Installed apps pick it up through **Update**.

Website changes under `Marketing Website/` deploy automatically on push to `main` (`pages.yml`).

### AI models (Vocal Remover)

The app downloads its models from the `models-v1` GitHub release (a **pre-release**, so it never becomes "latest" for the updater or website) and checks each file's SHA-256 (listed in `electron/stems.js`):

| Mode | File | Size | Source |
|---|---|---|---|
| Fast | `htdemucs_6s.onnx` | 115 MB | Demucs v4 `htdemucs_6s` by Meta AI, exported to ONNX (network only; STFT runs in JS) |
| Best quality | `bs_roformer_sw_6stem_fp16_mm.onnx` | 353 MB | BS-RoFormer SW 6-stem (community weights, rehosted by jarredou), ONNX export by elicwhite; attention Einsums rewritten as MatMul (same output, ~15% faster). v1.3.0 used `bs_roformer_sw_6stem_fp16.onnx`. |

The code is MIT, but the model weights are not covered by it: Meta describes the Demucs weights as for research use, and the BS-RoFormer SW weights have no stated license. ONNX Runtime is pinned to `onnxruntime-node@1.23.2`, the last version with Intel Mac support.

## 🛠 Tech Stack

Electron, React 19, Vite, yt-dlp, Deno (for YouTube's JS challenges), FFmpeg, ONNX Runtime (Demucs / BS-RoFormer).

## 📜 License

MIT
