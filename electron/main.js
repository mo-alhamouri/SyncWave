const { app, BrowserWindow, ipcMain, shell, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const engine = require('./engine');
const updater = require('./updater');
const convert = require('./convert');
const { getWaveform } = require('./waveform');

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
    // -N 4: download 4 fragments in parallel.
    const args = [url, '-o', outputTemplate, '--no-continue', '--no-playlist', '-N', '4', ...engine.baseArgs(), ...extraArgs];

    if (format === 'mp3-320') {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', '--convert-thumbnails', 'jpg', '--embed-thumbnail');
    } else {
        // Highest resolution up to the chosen one, then prefer YouTube's
        // H.264 + AAC streams: those are already Mac-compatible and only need
        // packing into an MP4 (no re-encoding). If a video has no H.264 at that
        // resolution, convert.ensureMacCompatible() converts it afterwards
        // (hardware encoder when available).
        const h = format === '720p' ? 720 : 1080;
        args.push('-f', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`);
        args.push('-S', `res:${h},vcodec:h264,acodec:aac`);
        // Merge into MKV (accepts any codec); convert.js then repacks it into
        // an MP4, which for H.264 + AAC is a fast copy, not a re-encode.
        args.push('--merge-output-format', 'mkv');
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
        if (['ExtractAudio', 'Merger', 'EmbedThumbnail', 'ThumbnailsConvertor'].includes(type)) {
            send('download-progress', { status: 'processing' });
        }
    });

    downloader.on('close', async () => {
        currentDownloadProcess = null;
        try {
            if (format !== 'mp3-320') {
                const video = fs.readdirSync(tempDownloadsDir).find((f) => /\.(mkv|mp4|webm)$/i.test(f) && !f.includes('.converting.'));
                if (video) {
                    const r = await convert.ensureMacCompatible(path.join(tempDownloadsDir, video), {
                        ffmpegPath: engine.state.ffmpegPath,
                        ffprobePath: engine.state.ffprobePath,
                        onProgress: (percent) => send('download-progress', { status: 'converting', percent }),
                    });
                    console.log(`[download] Mac compatibility: ${r.method}`);
                }
            }
            if (isStoppedByUser) { clearTemp(); send('download-stopped'); return; }
            if (finalize(format)) {
                send('download-completed');
                if (process.platform === 'darwin') app.setBadgeCount(app.getBadgeCount() + 1);
            } else {
                clearTemp();
                send('download-error', { error: 'No valid output file was found.' });
            }
        } catch (e) {
            clearTemp();
            if (isStoppedByUser) send('download-stopped');
            else send('download-error', { error: 'Finalizing failed: ' + e.message });
        }
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
    convert.stop();
    const p = currentDownloadProcess;
    if (!p) return;
    try {
        if (p.ytDlpProcess && typeof p.ytDlpProcess.kill === 'function') p.ytDlpProcess.kill();
        else if (typeof p.kill === 'function') p.kill();
    } catch (e) { console.error('Error stopping download process:', e); }
    currentDownloadProcess = null;
});

// --- IPC: TRIMMER ---
ipcMain.handle('get-waveform', async (event, filePath) => {
    try {
        await waitForEngine();
        return await getWaveform(engine.state.ffmpegPath, filePath);
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('select-file', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Audio & Video', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'] }, { name: 'All Files', extensions: ['*'] }],
    });
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
