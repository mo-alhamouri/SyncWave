const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const isDev = require('electron-is-dev');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const fixPath = require('fix-path');

// Fix the $PATH on macOS so that it can find ffmpeg if installed globally
fixPath();

let YTDlpWrap = require('yt-dlp-wrap');
if (YTDlpWrap.default) {
    YTDlpWrap = YTDlpWrap.default;
}

let mainWindow;
let ytDlpWrap = null;
let currentDownloadProcess = null;

// Directories setup
const userDataPath = app.getPath('userData');
const downloadsDir = path.join(app.getPath('downloads'), 'SyncWave');
const binDir = path.join(userDataPath, 'bin');
const ytDlpPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const cookiesPath = path.join(userDataPath, 'cookies.txt');

if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}

const https = require('https');

// Helper to download standalone yt-dlp binary from GitHub
function downloadStandaloneYtdlp(dest) {
    return new Promise((resolve, reject) => {
        let downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
        if (process.platform === 'darwin') {
            downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
        } else if (process.platform === 'win32') {
            downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
        }

        console.log(`Downloading standalone yt-dlp binary from: ${downloadUrl}`);

        const file = fs.createWriteStream(dest);
        const download = (url) => {
            https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    download(response.headers.location);
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download binary: HTTP ${response.statusCode}`));
                    return;
                }
                response.pipe(file);
                file.on('finish', () => {
                    file.close(() => {
                        fs.chmodSync(dest, '755');
                        resolve();
                    });
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => {});
                reject(err);
            });
        };
        download(downloadUrl);
    });
}

async function initYtdlp() {
    try {
        if (!fs.existsSync(ytDlpPath)) {
            console.log('Downloading yt-dlp binary...');
            await downloadStandaloneYtdlp(ytDlpPath);
        }
        ytDlpWrap = new YTDlpWrap(ytDlpPath);
        console.log('yt-dlp initialized.');
    } catch (error) {
        console.error('Failed to initialize yt-dlp:', error);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 850,
        title: "SyncWave Downloader",
        backgroundColor: "#080b11",
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    const startUrl = isDev 
        ? 'http://localhost:5173' 
        : `file://${path.join(__dirname, '../frontend/dist/index.html')}`;

    mainWindow.loadURL(startUrl);

    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.on('ready', async () => {
    await initYtdlp();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

// IPC Handlers

// Helper for yt-dlp flags
const getCommonFlags = () => {
    const flags = [
        '--no-check-certificates',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        '--geo-bypass',
        '--no-warnings',
        '--ignore-config',
        '--js-runtime', 'node'
    ];
    if (fs.existsSync(cookiesPath)) {
        flags.push('--cookies', cookiesPath);
    }
    return flags;
};

ipcMain.handle('get-info', async (event, videoUrl) => {
    if (!ytDlpWrap) return { error: 'yt-dlp not initialized' };

    const targetUrl = videoUrl.trim();
    
    try {
        console.log(`[INFO] Analyzing: ${targetUrl}`);
        
        // Phase 1: High-Speed Metadata
        let metadata = await ytDlpWrap.getVideoInfo([
            targetUrl, 
            '--flat-playlist', 
            '--dump-single-json',
            '--no-check-certificates',
            '--no-warnings',
            '--js-runtime', 'node'
        ]);
        
        // 1. Detect if it's a Playlist
        const isPlaylist = (metadata && metadata._type === 'playlist') || 
                           (metadata && Array.isArray(metadata.entries) && metadata.entries.length > 1) ||
                           (Array.isArray(metadata) && metadata.length > 1);

        if (isPlaylist) {
            const entries = Array.isArray(metadata) 
                ? metadata.filter(e => e && e.id && e.id !== e.playlist_id)
                : (metadata.entries || []).filter(e => e && e.id);
            
            const first = Array.isArray(metadata) ? (metadata.find(e => e.playlist_title) || metadata[0]) : metadata;
            
            return {
                isPlaylist: true,
                id: first.playlist_id || first.id,
                title: first.playlist_title || first.title || 'Untitled Playlist',
                channel: first.playlist_uploader || first.uploader || first.channel || 'Unknown Channel',
                thumbnail: `https://i.ytimg.com/vi/${entries[0]?.id}/hqdefault.jpg`,
                videoCount: entries.length,
                entries: entries.map((e, index) => ({
                    index: index + 1,
                    id: e.id,
                    title: e.title || 'Untitled Video',
                    duration: e.duration || 0,
                    url: `https://www.youtube.com/watch?v=${e.id}`
                }))
            };
        }

        // 2. Single Video Processing
        // Force deep info to get accurate views/channel
        console.log("[INFO] Running Deep Analysis...");
        metadata = await ytDlpWrap.getVideoInfo([
            targetUrl,
            '--no-check-certificates',
            '--no-warnings',
            '--js-runtime', 'node'
        ]);

        const videoId = metadata.id || targetUrl.match(/(?:v=|\/|embed\/|watch\?v=)([0-9A-Za-z_-]{11})/)?.[1];
        const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        
        const response = {
            isPlaylist: false,
            id: videoId,
            title: metadata.title || metadata.fulltitle || 'Untitled Video',
            thumbnail: thumbnail,
            duration: metadata.duration || 0,
            viewCount: metadata.view_count || metadata.viewCount || 0,
            channel: metadata.channel || metadata.uploader || 'Unknown Channel',
            description: metadata.description ? metadata.description.slice(0, 200) + '...' : '',
        };

        console.log(`[INFO] Done: "${response.title}" | Thumb: ${response.thumbnail}`);
        return response;

    } catch (error) {
        console.error('[ERROR] Analysis failed:', error.message);
        return { error: 'Could not analyze video. Please check the URL.' };
    }
});

ipcMain.on('start-download', (event, url, format) => {
    if (!ytDlpWrap) return;

    const outputPath = path.join(downloadsDir, `%(title)s.%(ext)s`);
    let ytDlpArgs = [url, ...getCommonFlags(), '--ffmpeg-location', ffmpeg.path, '-o', outputPath];

    // High Quality Formats Mapping
    if (format === 'mp3' || format === 'mp3-320') {
        ytDlpArgs.push('-x', '--audio-format', 'mp3', '--audio-quality', '0'); 
    } else if (format === 'flac') {
        ytDlpArgs.push('-x', '--audio-format', 'flac');
    } else if (format === 'wav') {
        ytDlpArgs.push('-x', '--audio-format', 'wav');
    } else if (format === 'aac') {
        ytDlpArgs.push('-x', '--audio-format', 'm4a');
    } else if (format === '4k') {
        ytDlpArgs.push('-f', 'bestvideo[height<=2160]+bestaudio/best[height<=2160]');
    } else if (format === '1440p') {
        ytDlpArgs.push('-f', 'bestvideo[height<=1440]+bestaudio/best[height<=1440]');
    } else if (format === '1080p') {
        ytDlpArgs.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]');
    } else {
        ytDlpArgs.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
    }

    currentDownloadProcess = ytDlpWrap.exec(ytDlpArgs);

    currentDownloadProcess.on('progress', (progress) => {
        mainWindow.webContents.send('download-progress', {
            percent: progress.percent,
            speed: progress.currentSpeed,
            eta: progress.eta
        });
    });

    currentDownloadProcess.on('ytDlpEvent', (event, data) => {
        if (data.includes('Extracting audio') || data.includes('Destination:')) {
            mainWindow.webContents.send('download-progress', { status: 'processing', message: 'Finalizing...' });
        }
    });

    currentDownloadProcess.on('close', () => {
        mainWindow.webContents.send('download-completed', { message: 'Download finished!' });
        currentDownloadProcess = null;
    });

    currentDownloadProcess.on('error', (err) => {
        mainWindow.webContents.send('download-error', { error: err.message });
        currentDownloadProcess = null;
    });
});

ipcMain.on('stop-download', () => {
    if (currentDownloadProcess && currentDownloadProcess.ytDlpProcess) {
        currentDownloadProcess.ytDlpProcess.kill('SIGTERM');
        currentDownloadProcess = null;
    }
});

ipcMain.on('open-downloads-folder', () => {
    shell.openPath(downloadsDir);
});
