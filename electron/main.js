const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const isDev = require('electron-is-dev');
const { v4: uuidv4 } = require('uuid');
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
        width: 1100,
        height: 800,
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
        '--geo-bypass'
    ];
    if (fs.existsSync(cookiesPath)) {
        flags.push('--cookies', cookiesPath);
    }
    return flags;
};

ipcMain.handle('get-info', async (event, videoUrl) => {
    if (!ytDlpWrap) return { error: 'yt-dlp not initialized' };

    let targetUrl = videoUrl.trim();
    if (targetUrl.includes('list=')) {
        try {
            const urlObj = new URL(targetUrl);
            const playlistId = urlObj.searchParams.get('list');
            if (playlistId) {
                targetUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
            }
        } catch (e) {
            const match = targetUrl.match(/[&?]list=([^&]+)/);
            if (match && match[1]) {
                targetUrl = `https://www.youtube.com/playlist?list=${match[1]}`;
            }
        }
    }

    try {
        // Flat playlist info
        const flatMetadata = await ytDlpWrap.getVideoInfo([
            targetUrl, 
            '--flat-playlist', 
            '--dump-single-json',
            ...getCommonFlags()
        ]);
        
        let isPlaylist = false;
        let entries = [];
        let playlistTitle = 'Untitled Playlist';
        let playlistId = '';
        let channel = 'Unknown Channel';

        if (Array.isArray(flatMetadata)) {
            if (flatMetadata.length > 0) {
                const filtered = flatMetadata.filter(e => e && e.id && (e._type === 'url' || !e._type) && e.id !== e.playlist_id);
                if (filtered.length > 0 || flatMetadata.some(e => e.playlist_id)) {
                    isPlaylist = true;
                    entries = filtered;
                    const first = flatMetadata.find(e => e.playlist_title || e.playlist || e.playlist_id) || flatMetadata[0];
                    playlistTitle = first.playlist_title || first.playlist || playlistTitle;
                    playlistId = first.playlist_id || playlistId;
                    channel = first.playlist_uploader || first.playlist_channel || channel;
                }
            }
        } else if (flatMetadata && (flatMetadata._type === 'playlist' || Array.isArray(flatMetadata.entries))) {
            isPlaylist = true;
            const rawEntries = Array.isArray(flatMetadata.entries) ? flatMetadata.entries : [];
            entries = rawEntries.filter(e => e && e.id && (e._type === 'url' || !e._type));
            playlistTitle = flatMetadata.title || playlistTitle;
            playlistId = flatMetadata.id || playlistId;
            channel = flatMetadata.uploader || flatMetadata.channel || channel;
        }

        if (isPlaylist) {
            return {
                isPlaylist: true,
                id: playlistId,
                title: playlistTitle,
                channel: channel,
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

        // Single video info
        const metadata = await ytDlpWrap.getVideoInfo([videoUrl, ...getCommonFlags()]);
        return {
            isPlaylist: false,
            id: metadata.id,
            title: metadata.title,
            thumbnail: metadata.thumbnail || (metadata.thumbnails && metadata.thumbnails.length ? metadata.thumbnails[metadata.thumbnails.length - 1].url : null),
            duration: metadata.duration,
            viewCount: metadata.view_count,
            channel: metadata.channel,
            description: metadata.description ? metadata.description.slice(0, 200) + '...' : '',
        };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.on('start-download', (event, url, format) => {
    if (!ytDlpWrap) return;

    const fileExtension = format === 'mp3' ? 'mp3' : 'mp4';
    // We use original title or uuid
    const outputPath = path.join(downloadsDir, `%(title)s.%(ext)s`);

    let ytDlpArgs = [];
    if (format === 'mp3') {
        ytDlpArgs = [
            url,
            ...getCommonFlags(),
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--ffmpeg-location', ffmpeg.path,
            '-o', outputPath
        ];
    } else {
        ytDlpArgs = [
            url,
            ...getCommonFlags(),
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--merge-output-format', 'mp4',
            '--ffmpeg-location', ffmpeg.path,
            '-o', outputPath
        ];
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
            mainWindow.webContents.send('download-progress', { status: 'processing', message: 'Converting...' });
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
