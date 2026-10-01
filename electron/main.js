const { app, BrowserWindow, ipcMain, shell, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const engine = require('./engine');
const updater = require('./updater');

// --- ERROR HANDLING ---
function reportError(title, error) {
    const message = error instanceof Error ? `${error.message}\n\nStack:\n${error.stack}` : String(error);
    console.error(title, error);
    if (dialog && dialog.showErrorBox) dialog.showErrorBox(title, message);
}
process.on('uncaughtException', (e) => reportError('SyncWave Uncaught Exception', e));
process.on('unhandledRejection', (r) => console.error('SyncWave Unhandled Rejection', r));

const isDev = !app.isPackaged;

// --- STATE ---
let mainWindow = null;
let userDataPath = '';
let finalDownloadsDir = '';
let tempDownloadsDir = '';
let ytDlpWrap = null;
let engineReady = null;          // Promise resolved when the engine is initialised
let currentDownloadProcess = null;
let isStoppedByUser = false;

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWrap() {
    const mod = require('yt-dlp-wrap');
    const YTDlpWrap = mod.default || mod;
    ytDlpWrap = new YTDlpWrap(engine.state.ytDlpPath);
}

// --- IPC: APP / UPDATES ---
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('get-engine-info', () => ({ ytDlp: engine.state.ytDlpVersion, jsRuntime: engine.state.jsRuntime }));
ipcMain.handle('check-for-updates', () => updater.check());
ipcMain.handle('download-update', () => updater.download());
ipcMain.on('quit-and-install', () => {
    const r = updater.install();
    if (r && r.error) send('update-error', { error: r.error });
});

// --- IPC: WINDOW ---
ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow && mainWindow.maximize());
ipcMain.on('window-unmaximize', () => mainWindow && mainWindow.unmaximize());
ipcMain.handle('window-is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false));
ipcMain.on('open-downloads-folder', () => shell.openPath(finalDownloadsDir));
ipcMain.on('clear-badge', () => { if (process.platform === 'darwin') app.setBadgeCount(0); });

// --- IPC: MEDIA INFO ---
async function waitForEngine() {
    if (!engineReady) throw new Error('Engine not ready.');
    await engineReady;
    if (!ytDlpWrap) throw new Error('Engine not ready.');
}

async function fetchInfo(url) {
    // -J returns one JSON document (a video, or a playlist with flat entries).
    const out = await ytDlpWrap.execPromise([url, '-J', '--flat-playlist', '-f', 'bv*+ba/b', ...engine.baseArgs()]);
    return JSON.parse(out);
}

ipcMain.handle('get-info', async (event, url) => {
    try {
        await waitForEngine();
        let metadata;
        try {
            metadata = await fetchInfo(url);
        } catch (err) {
            if (!engine.isRecoverable(err.message)) throw err;
            // YouTube changed something: grab the newest yt-dlp and try again.
            await engine.updateYtDlp('nightly').catch(() => {});
            metadata = await fetchInfo(url);
        }
        if (metadata._type === 'playlist') {
            return {
                id: metadata.id, title: metadata.title, channel: metadata.uploader || 'Playlist', isPlaylist: true,
                entries: (metadata.entries || []).filter(Boolean).map((e) => ({ id: e.id, title: e.title, duration: e.duration, url: e.webpage_url || e.url })),
            };
        }
        return { id: metadata.id, title: metadata.title, thumbnail: metadata.thumbnail, duration: metadata.duration, channel: metadata.uploader, viewCount: metadata.view_count, isPlaylist: false };
    } catch (error) {
        return { error: engine.cleanError(error.message) };
    }
});

// --- IPC: DOWNLOAD ---
function buildDownloadArgs(url, format, startTime, endTime, extraArgs = []) {
    const outputTemplate = path.join(tempDownloadsDir, '%(title)s.%(ext)s');
    const args = [url, '-o', outputTemplate, '--no-continue', '--no-playlist', ...engine.baseArgs(), ...extraArgs];

    if (format === 'mp3-320') {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', '--convert-thumbnails', 'jpg', '--embed-thumbnail');
    } else {
        args.push('--merge-output-format', 'mkv', '--recode-video', 'mp4');
        // Transcode to H.264/AAC yuv420p for Finder / Quick Look / QuickTime compatibility.
        args.push('--postprocessor-args', 'VideoConvertor:-c:v libx264 -c:a aac -pix_fmt yuv420p -b:a 192k -profile:v high -level 4.0');
        if (format === '4k') args.push('-f', 'bestvideo[height<=2160]+bestaudio/best');
        else if (format === '1080p') args.push('-f', 'bestvideo[height<=1080]+bestaudio/best');
        else if (format === '720p') args.push('-f', 'bestvideo[height<=720]+bestaudio/best');
    }
    if (startTime || endTime) {
        args.push('--download-sections', `*${startTime || 0}-${endTime || 'inf'}`, '--force-keyframes-at-cuts');
    }
    return args;
}

function clearTemp() {
    try { for (const f of fs.readdirSync(tempDownloadsDir)) { try { fs.rmSync(path.join(tempDownloadsDir, f), { recursive: true, force: true }); } catch (e) {} } } catch (e) {}
}

function finalize(format) {
    let moved = false;
    for (const file of fs.readdirSync(tempDownloadsDir)) {
        const oldPath = path.join(tempDownloadsDir, file);
        const isTarget = format === 'mp3-320' ? file.endsWith('.mp3') : file.endsWith('.mp4');
        if (isTarget) {
            let newPath = path.join(finalDownloadsDir, file);
            if (fs.existsSync(newPath)) {
                const ext = path.extname(file);
                newPath = path.join(finalDownloadsDir, `${path.basename(file, ext)} (${Date.now()})${ext}`);
            }
            try { fs.renameSync(oldPath, newPath); } catch (e) { fs.copyFileSync(oldPath, newPath); fs.unlinkSync(oldPath); }
            moved = true;
        } else {
            try { fs.rmSync(oldPath, { recursive: true, force: true }); } catch (e) {}
        }
    }
    return moved;
}

// Retry ladder for downloads YouTube rejects (e.g. HTTP 403):
//  1. normal attempt with the current engine
//  2. update yt-dlp to the newest nightly build and retry
//  3. retry with alternative YouTube player clients
const RETRY_STEPS = [
    { prepare: null, extra: [] },
    { prepare: () => engine.updateYtDlp('nightly'), extra: [] },
    { prepare: null, extra: ['--extractor-args', 'youtube:player_client=default,web_safari,web_embedded,tv'] },
];

function startAttempt(url, format, startTime, endTime, step) {
    const args = buildDownloadArgs(url, format, startTime, endTime, RETRY_STEPS[step].extra);
    console.log(`[download] attempt ${step + 1}: yt-dlp ${args.join(' ')}`);
    const downloader = ytDlpWrap.exec(args);
    currentDownloadProcess = downloader;

    downloader.on('progress', (progress) => send('download-progress', progress));
    downloader.on('ytDlpEvent', (type) => {
        if (['ExtractAudio', 'Merger', 'VideoConvertor', 'EmbedThumbnail', 'ThumbnailsConvertor'].includes(type)) {
            send('download-progress', { status: 'processing' });
        }
    });

    downloader.on('close', () => {
        try {
            if (finalize(format)) {
                send('download-completed');
                if (process.platform === 'darwin') app.setBadgeCount(app.getBadgeCount() + 1);
            } else {
                clearTemp();
                send('download-error', { error: 'No valid output file was found.' });
            }
        } catch (e) {
            send('download-error', { error: 'Finalizing failed: ' + e.message });
        }
        currentDownloadProcess = null;
    });

    downloader.on('error', async (error) => {
        currentDownloadProcess = null;
        clearTemp();
        if (isStoppedByUser) { send('download-stopped'); return; }
        const next = step + 1;
        if (engine.isRecoverable(error.message) && next < RETRY_STEPS.length) {
            console.warn(`[download] attempt ${step + 1} failed (${engine.cleanError(error.message)}); retrying...`);
            send('download-progress', { status: 'retrying', percent: 5 });
            try { if (RETRY_STEPS[next].prepare) await RETRY_STEPS[next].prepare(); } catch (e) { console.error('[download] prepare failed:', e.message); }
            if (isStoppedByUser) { send('download-stopped'); return; }
            startAttempt(url, format, startTime, endTime, next);
            return;
        }
        send('download-error', { error: engine.cleanError(error.message) });
    });
}

ipcMain.on('start-download', async (event, url, format, startTime, endTime) => {
    try {
        await waitForEngine();
        isStoppedByUser = false;
        clearTemp();
        startAttempt(url, format, startTime, endTime, 0);
    } catch (e) {
        send('download-error', { error: e.message });
    }
});

ipcMain.on('stop-download', () => {
    isStoppedByUser = true;
    const p = currentDownloadProcess;
    if (!p) return;
    try {
        if (p.ytDlpProcess && typeof p.ytDlpProcess.kill === 'function') p.ytDlpProcess.kill();
        else if (typeof p.kill === 'function') p.kill();
    } catch (e) { console.error('Error stopping download process:', e); }
    currentDownloadProcess = null;
});

// --- IPC: TRIMMER ---
ipcMain.handle('select-file', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (!result.canceled && result.filePaths.length > 0) return { path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
    return null;
});

ipcMain.handle('trim-local-file', async (event, filePath, format, startTime, endTime) => {
    const ext = format.toLowerCase().includes('mp3') ? 'mp3' : 'mp4';
    const originalName = path.basename(filePath, path.extname(filePath));
    const outputPath = path.join(finalDownloadsDir, `${originalName} Trimmed.${ext}`);
    const ffmpegPath = engine.state.ffmpegPath;

    return new Promise((resolve) => {
        if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return resolve({ error: 'Video Processor not found. Please wait for initialization.' });
        const args = ['-y', '-ss', String(startTime), '-to', String(endTime), '-i', filePath];
        if (ext === 'mp4') args.push('-c:v', 'copy', '-c:a', 'aac');
        else args.push('-c', 'copy');
        args.push(outputPath);
        const proc = spawn(ffmpegPath, args);
        proc.on('close', (code) => resolve(code === 0 ? { success: true, path: outputPath } : { error: `Trimming failed (Error ${code})` }));
        proc.on('error', (err) => resolve({ error: 'Trimmer start error: ' + err.message }));
    });
});

// --- APP READY ---
app.whenReady().then(async () => {
    try {
        userDataPath = app.getPath('userData');
        finalDownloadsDir = app.getPath('downloads');
        tempDownloadsDir = path.join(userDataPath, 'temp_downloads');
        fs.mkdirSync(tempDownloadsDir, { recursive: true });

        try { require('fix-path')(); } catch (e) {}

        protocol.registerFileProtocol('media', (request, callback) => {
            const url = request.url.replace('media://', '');
            try { return callback(decodeURIComponent(url)); } catch (error) {}
        });

        createWindow();
        updater.init(send);

        engineReady = engine.init({
            userDataPath,
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            status: (msg) => send('init-status', msg),
        }).then(() => {
            createWrap();
            send('init-status', ''); // hide the "Initializing" overlay
        });
        engineReady.catch((err) => {
            send('init-status', '');
            reportError('SyncWave could not start its media engine', err);
        });
    } catch (err) {
        reportError('Critical Startup Error', err);
    }
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300, height: 850,
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#080b11',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    const distIndex = path.join(__dirname, '../frontend/dist/index.html');
    if (isDev) mainWindow.loadURL('http://localhost:5173').catch(() => mainWindow.loadFile(distIndex).catch(() => {}));
    else mainWindow.loadFile(distIndex).catch(() => {});
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
