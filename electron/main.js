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
const finalDownloadsDir = app.getPath('downloads');
const tempDownloadsDir = path.join(userDataPath, 'temp_downloads');
const binDir = path.join(userDataPath, 'bin');
const ytDlpPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const cookiesPath = path.join(userDataPath, 'cookies.txt');

if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}
if (!fs.existsSync(tempDownloadsDir)) {
    fs.mkdirSync(tempDownloadsDir, { recursive: true });
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
        
        let rawResult = await ytDlpWrap.getVideoInfo([
            targetUrl, 
            '--flat-playlist', 
            '--dump-single-json',
            '--no-check-certificates',
            '--no-warnings',
            '--js-runtime', 'node'
        ]);
        
        let metadata = Array.isArray(rawResult) 
            ? rawResult.find(o => o && o.id && (o.title || o.fulltitle) && o._version === undefined) 
            : rawResult;

        if (!metadata) {
            metadata = Array.isArray(rawResult) ? rawResult[0] : rawResult;
        }

        const isPlaylist = (metadata && metadata._type === 'playlist') || 
                           (metadata && Array.isArray(metadata.entries) && metadata.entries.length > 1);

        if (isPlaylist) {
            const entries = metadata.entries.filter(e => e && e.id && e.id !== metadata.id);
            console.log(`[INFO] Playlist detected: "${metadata.title}" (${entries.length} items)`);
            
            return {
                isPlaylist: true,
                id: metadata.id,
                title: metadata.title || 'Untitled Playlist',
                channel: metadata.uploader || metadata.channel || 'Unknown Channel',
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

        console.log("[INFO] Running High-Quality Analysis...");
        let deepRaw = await ytDlpWrap.getVideoInfo([
            targetUrl,
            '--no-check-certificates',
            '--no-warnings',
            '--js-runtime', 'node'
        ]);
        
        metadata = Array.isArray(deepRaw) ? deepRaw.find(o => o && o.id && o._version === undefined) || deepRaw[0] : deepRaw;

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

        console.log(`[INFO] Done: "${response.title}" | ID: ${response.id}`);
        return response;

    } catch (error) {
        console.error('[ERROR] Analysis failed:', error.message);
        return { error: 'Could not analyze video. Please check the URL.' };
    }
});

ipcMain.handle('get-waveform', async (event, videoUrl) => {
    if (!ytDlpWrap) return { error: 'yt-dlp not initialized' };
    
    try {
        console.log(`[WAVEFORM] Generating for: ${videoUrl}`);
        const metadata = await ytDlpWrap.getVideoInfo([
            videoUrl,
            '-f', 'bestaudio',
            '--get-url',
            '--no-check-certificates',
            '--no-warnings'
        ]);
        
        const audioUrl = Array.isArray(metadata) ? metadata[0] : metadata;
        if (!audioUrl || typeof audioUrl !== 'string') throw new Error('Could not get audio stream');

        const { spawn } = require('child_process');
        const ff = spawn(ffmpeg.path, [
            '-i', audioUrl,
            '-ac', '1',
            '-filter:a', 'aresample=8000',
            '-f', 's16le',
            '-acodec', 'pcm_s16le',
            'pipe:1'
        ]);

        return new Promise((resolve) => {
            let samples = [];
            ff.stdout.on('data', (chunk) => {
                const skip = samples.length > 50000 ? 10000 : 4000;
                for (let i = 0; i < chunk.length; i += skip) {
                    if (i + 1 < chunk.length) {
                      samples.push(Math.abs(chunk.readInt16LE(i)) / 32768);
                    }
                }
            });
            ff.on('close', () => {
                const step = Math.max(1, Math.floor(samples.length / 100));
                const points = [];
                for(let i=0; i<samples.length && points.length < 100; i+=step) points.push(samples[i]);
                while(points.length < 100) points.push(0);
                resolve(points);
            });
            setTimeout(() => { ff.kill(); resolve([]); }, 15000);
        });
    } catch (e) {
        console.error('[WAVEFORM] Failed:', e.message);
        return [];
    }
});

ipcMain.on('start-download', (event, url, format, startTime, endTime) => {
    if (!ytDlpWrap) return;

    const tempOutputPath = path.join(tempDownloadsDir, '%(title)s.%(ext)s');
    
    let ytDlpArgs = [
        url, 
        ...getCommonFlags(), 
        '--ffmpeg-location', ffmpeg.path, 
        '-o', tempOutputPath,
        '--newline',
        '--force-overwrites',
        '--no-keep-video'
    ];

    if (startTime !== undefined && endTime !== undefined) {
        const formatTime = (sec) => {
            const h = Math.floor(sec / 3600).toString().padStart(2, '0');
            const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
            const s = Math.floor(sec % 60).toString().padStart(2, '0');
            return `${h}:${m}:${s}`;
        };
        ytDlpArgs.push('--download-sections', `*${formatTime(startTime)}-${formatTime(endTime)}`);
        ytDlpArgs.push('--force-keyframes-at-cuts');
    }

    if (format.includes('mp3')) {
        ytDlpArgs.push('-x', '--audio-format', 'mp3', '--audio-quality', '0'); 
    } else if (format === 'aac') {
        ytDlpArgs.push('-x', '--audio-format', 'm4a');
    } else if (format === '4k') {
        ytDlpArgs.push('-f', 'bestvideo[height<=2160]+bestaudio/best[height<=2160]', '--recode-video', 'mp4');
    } else if (format === '1440p') {
        ytDlpArgs.push('-f', 'bestvideo[height<=1440]+bestaudio/best[height<=1440]', '--recode-video', 'mp4');
    } else if (format === '1080p') {
        ytDlpArgs.push('-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]/best', '--merge-output-format', 'mp4');
    } else if (format === '720p') {
        ytDlpArgs.push('-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]/best', '--merge-output-format', 'mp4');
    } else {
        ytDlpArgs.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4');
    }

    try {
        console.log(`[EXEC] yt-dlp ${ytDlpArgs.join(' ')}`);
        currentDownloadProcess = ytDlpWrap.exec(ytDlpArgs);

        let lastFilePath = null;

        currentDownloadProcess.on('progress', (progress) => {
            mainWindow.webContents.send('download-progress', {
                status: 'downloading',
                percent: progress.percent,
                speed: progress.currentSpeed,
                eta: progress.eta
            });
        });

        currentDownloadProcess.on('ytDlpEvent', (event, data) => {
            console.log(`[YT-DLP] ${data}`);
            
            if (data.includes('Destination:') || data.includes('Converting video to') || data.includes('[ExtractAudio]') || data.includes('Merging formats into')) {
                // Try to catch the filename
                if (data.includes('into "')) {
                    const match = data.match(/into "(.+)"/);
                    if (match) lastFilePath = match[1];
                } else if (data.includes(': ')) {
                    const parts = data.split(': ');
                    if (parts.length > 1 && parts[1].includes(tempDownloadsDir)) {
                        lastFilePath = parts[1].trim();
                    }
                }
            }

            if (data.includes('Extracting audio') || data.includes('[ExtractAudio]') || data.includes('Merging formats') || data.includes('ffmpeg') || data.includes('Converting video')) {
                mainWindow.webContents.send('download-progress', { 
                    status: 'processing', 
                    message: 'Finalizing & Encoding High-Quality File...' 
                });
            }
        });

        currentDownloadProcess.on('close', async (code) => {
            if (code === 0) {
                // FALLBACK: If we missed the path, find the newest file in temp
                if (!lastFilePath || !fs.existsSync(lastFilePath)) {
                    const files = fs.readdirSync(tempDownloadsDir).map(f => ({
                        name: f,
                        path: path.join(tempDownloadsDir, f),
                        time: fs.statSync(path.join(tempDownloadsDir, f)).mtime.getTime()
                    })).sort((a, b) => b.time - a.time);
                    if (files.length > 0) lastFilePath = files[0].path;
                }

                if (lastFilePath && fs.existsSync(lastFilePath)) {
                    await new Promise(r => setTimeout(r, 1500)); // Safer wait
                    try {
                        const fileName = path.basename(lastFilePath);
                        const destPath = path.join(finalDownloadsDir, fileName);
                        fs.copyFileSync(lastFilePath, destPath);
                        fs.unlinkSync(lastFilePath);
                        console.log(`[SUCCESS] File saved: ${destPath}`);
                        mainWindow.webContents.send('download-completed', { message: 'Download Complete! Saved to your Downloads folder' });
                    } catch (moveError) {
                        console.error('[ERROR] Save failed:', moveError);
                        mainWindow.webContents.send('download-error', { error: 'Download finished but failed to save to folder.' });
                    }
                } else {
                    mainWindow.webContents.send('download-error', { error: 'Process finished but no file was generated.' });
                }
            } else if (code !== 0) {
                mainWindow.webContents.send('download-error', { error: `Download engine failed (code ${code}).` });
            }
            currentDownloadProcess = null;
        });

        currentDownloadProcess.on('error', (err) => {
            console.error('[FATAL] Process Error:', err.message);
            mainWindow.webContents.send('download-error', { error: `Connection lost: ${err.message}` });
            currentDownloadProcess = null;
        });
    } catch (e) {
        console.error('[FATAL] Execution Exception:', e.message);
        mainWindow.webContents.send('download-error', { error: `Execution error: ${e.message}` });
    }
});

ipcMain.on('stop-download', () => {
    if (currentDownloadProcess && currentDownloadProcess.ytDlpProcess) {
        currentDownloadProcess.ytDlpProcess.kill('SIGTERM');
        currentDownloadProcess = null;
    }
});

ipcMain.on('open-downloads-folder', () => {
    shell.openPath(finalDownloadsDir);
});
