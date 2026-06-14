const { app, BrowserWindow, ipcMain, shell, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const util = require('util');
const https = require('https');
const execPromise = util.promisify(exec);

// 1. ABSOLUTE TOP-LEVEL ERROR HANDLING
function reportError(title, error) {
    const message = error instanceof Error ? 
        `${error.message}\n\nStack:\n${error.stack}` : 
        `Non-Error thrown: ${JSON.stringify(error) || String(error)}`;
    console.error(title, error);
    if (dialog && dialog.showErrorBox) {
        dialog.showErrorBox(title, message);
    }
}

process.on('uncaughtException', (error) => reportError('SyncWave Uncaught Exception', error));
process.on('unhandledRejection', (reason) => reportError('SyncWave Unhandled Rejection', reason));

let isDev = false;
try { isDev = !app.isPackaged; } catch (e) { isDev = false; }

// --- GLOBAL STATE ---
let autoUpdater = null;
let ffmpegPath = '';
let ffprobePath = '';
let ytDlpPath = '';
let binDir = '';
let userDataPath = '';
let finalDownloadsDir = '';
let tempDownloadsDir = '';
let mainWindow = null;
let currentDownloadProcess = null;
let ytDlpWrap = null;
let YTDlpWrap = null;

// --- AUTO UPDATER LOGIC ---

function setupAutoUpdater() {
    try {
        const { autoUpdater: updater } = require('electron-updater');
        autoUpdater = updater;
        
        autoUpdater.on('checking-for-update', () => console.log('Checking for update...'));
        autoUpdater.on('update-available', (info) => {
            console.log('Update available:', info);
            if (mainWindow) mainWindow.webContents.send('update-available', info);
        });
        autoUpdater.on('update-not-available', (info) => console.log('Update not available:', info));
        autoUpdater.on('error', (err) => console.error('Error in auto-updater:', err));
        autoUpdater.on('download-progress', (progressObj) => console.log('Download progress:', progressObj));
        autoUpdater.on('update-downloaded', (info) => {
            console.log('Update downloaded:', info);
            if (mainWindow) mainWindow.webContents.send('update-downloaded', info);
        });

        autoUpdater.checkForUpdatesAndNotify();
    } catch (e) { console.error('AutoUpdater setup failed:', e); }
}

// --- BINARY MANAGEMENT (THE ENGINE) ---

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const request = (targetUrl) => {
            https.get(targetUrl, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    request(response.headers.location);
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`Server returned ${response.statusCode} for ${targetUrl}`));
                    return;
                }
                response.pipe(file);
                file.on('finish', () => {
                    file.close(() => {
                        try {
                            fs.chmodSync(dest, '755');
                            resolve();
                        } catch (e) { reject(e); }
                    });
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => {});
                reject(err);
            });
        };
        request(url);
    });
}

// Check if a binary actually runs on the current CPU
function verifyBinary(p) {
    if (!p || !fs.existsSync(p)) return Promise.resolve(false);
    return new Promise(r => {
        const proc = spawn(p, ['-version']);
        proc.on('error', () => r(false));
        proc.on('close', (code) => r(code === 0));
    });
}

async function ensureBinaries() {
    const platform = process.platform;
    const arch = process.arch;
    const isWin = platform === 'win32';
    
    // Internal bin location
    const internalBinDir = path.join(userDataPath, 'bin_v1');
    if (!fs.existsSync(internalBinDir)) fs.mkdirSync(internalBinDir, { recursive: true });

    ffmpegPath = path.join(internalBinDir, isWin ? 'ffmpeg.exe' : 'ffmpeg');
    ffprobePath = path.join(internalBinDir, isWin ? 'ffprobe.exe' : 'ffprobe');
    ytDlpPath = path.join(internalBinDir, isWin ? 'yt-dlp.exe' : 'yt-dlp');

    const status = (msg) => { if (mainWindow) mainWindow.webContents.send('init-status', msg); };

    // 1. Ensure yt-dlp
    if (!fs.existsSync(ytDlpPath)) {
        status('Downloading Media Engine...');
        let url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
        if (platform === 'darwin') url += '_macos';
        else if (isWin) url += '.exe';
        await downloadFile(url, ytDlpPath);
    }

    // 2. Resolve & Verify FFmpeg / FFprobe
    let ready = await verifyBinary(ffmpegPath) && await verifyBinary(ffprobePath);
    
    if (!ready) {
        status('Orchestrating Video Processors...');
        
        // Try bundled ones first (Search in app.asar.unpacked)
        if (app.isPackaged) {
            const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked');
            function deepSearch(base, target) {
                if (!fs.existsSync(base)) return null;
                const entries = fs.readdirSync(base);
                for (const entry of entries) {
                    const fullPath = path.join(base, entry);
                    if (entry === target) return fullPath;
                    if (fs.statSync(fullPath).isDirectory()) {
                        const found = deepSearch(fullPath, target);
                        if (found) return found;
                    }
                }
                return null;
            }

            const bundledFfmpeg = deepSearch(unpackedPath, isWin ? 'ffmpeg.exe' : 'ffmpeg');
            const bundledFfprobe = deepSearch(unpackedPath, isWin ? 'ffprobe.exe' : 'ffprobe');

            if (await verifyBinary(bundledFfmpeg) && await verifyBinary(bundledFfprobe)) {
                fs.copyFileSync(bundledFfmpeg, ffmpegPath);
                fs.copyFileSync(bundledFfprobe, ffprobePath);
                fs.chmodSync(ffmpegPath, '755');
                fs.chmodSync(ffprobePath, '755');
                ready = true;
            }
        } else {
            // Dev environment
            try {
                const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
                const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
                if (await verifyBinary(ffmpegInstaller.path) && await verifyBinary(ffprobeInstaller.path)) {
                    ffmpegPath = ffmpegInstaller.path;
                    ffprobePath = ffprobeInstaller.path;
                    ready = true;
                }
            } catch (e) {}
        }
    }

    // 3. EMERGENCY DOWNLOAD (Definitive fix for architecture mismatches)
    if (!ready) {
        status('Downloading Native Processors (Architecture Recovery)...');
        const base = 'https://github.com/mo-alhamouri/SyncWave/releases/download/v1.1.1/';
        const archSuffix = platform === 'darwin' ? (arch === 'arm64' ? 'arm64' : 'x64') : 'win64';
        
        await downloadFile(`${base}ffmpeg-${archSuffix}${isWin ? '.exe' : ''}`, ffmpegPath);
        await downloadFile(`${base}ffprobe-${archSuffix}${isWin ? '.exe' : ''}`, ffprobePath);
        
        ready = await verifyBinary(ffmpegPath) && await verifyBinary(ffprobePath);
    }

    if (!ready) throw new Error('Critical: Binary processors could not be initialized for this architecture.');

    if (YTDlpWrap) {
        ytDlpWrap = new YTDlpWrap(ytDlpPath);
    }
}

// --- IPC HANDLERS ---

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('check-for-updates', async () => {
    if (!autoUpdater) return { error: 'Updater not initialized' };
    try {
        const result = await autoUpdater.checkForUpdates();
        return result ? result.updateInfo : { version: app.getVersion() };
    } catch (e) { return { error: e.message }; }
});
ipcMain.on('quit-and-install', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });
ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow && mainWindow.maximize());
ipcMain.on('window-unmaximize', () => mainWindow && mainWindow.unmaximize());
ipcMain.handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);
ipcMain.on('open-downloads-folder', () => shell.openPath(finalDownloadsDir));
ipcMain.on('clear-badge', () => { if (process.platform === 'darwin') app.setBadgeCount(0); });

ipcMain.handle('list-local-volumes', async () => {
    const volumes = [
        { name: 'Home', path: app.getPath('home'), type: 'home' },
        { name: 'Desktop', path: app.getPath('desktop'), type: 'folder' },
        { name: 'Downloads', path: app.getPath('downloads'), type: 'folder' },
        { name: 'Documents', path: app.getPath('documents'), type: 'folder' },
        { name: 'Movies', path: app.getPath('videos'), type: 'folder' },
        { name: 'Pictures', path: app.getPath('pictures'), type: 'folder' },
        { name: 'Music', path: app.getPath('music'), type: 'folder' }
    ];
    if (process.platform === 'darwin') {
        try {
            const external = fs.readdirSync('/Volumes');
            external.forEach(v => {
                if (v !== 'Macintosh HD' && !v.startsWith('.')) {
                    volumes.push({ name: v, path: path.join('/Volumes', v), type: 'external' });
                }
            });
        } catch (e) {}
    }
    return volumes;
});

ipcMain.handle('list-devices', async () => {
    const adbPath = 'adb';
    const devices = [];
    try {
        const { stdout } = await execPromise(`"${adbPath}" devices`);
        const lines = stdout.split('\n');
        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].trim().split(/\s+/);
            if (parts.length >= 2 && parts[1] === 'device') {
                devices.push({ id: parts[0], name: `Android Phone (${parts[0]})`, type: 'android' });
            }
        }
    } catch (e) {}
    return devices;
});

ipcMain.handle('list-files', async (event, targetPath, deviceId) => {
    if (!deviceId) {
        let absolutePath = targetPath || app.getPath('home');
        if (!fs.existsSync(absolutePath)) absolutePath = app.getPath('home');
        try {
            const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
            return entries.filter(entry => !entry.name.startsWith('.')).map(entry => {
                const fullPath = path.join(absolutePath, entry.name);
                try {
                    const stats = fs.statSync(fullPath);
                    return { name: entry.name, path: fullPath, isDirectory: entry.isDirectory(), size: stats.size, dateModified: stats.mtime, type: entry.isDirectory() ? 'directory' : path.extname(entry.name).toLowerCase() };
                } catch (e) { return null; }
            }).filter(Boolean);
        } catch (e) { return { error: e.message }; }
    } else {
        let remotePath = (targetPath || '/sdcard').replace(/\/+/g, '/');
        if (!remotePath.endsWith('/')) remotePath += '/';
        try {
            const { stdout } = await execPromise(`adb -s ${deviceId} shell ls -1F "${remotePath}"`);
            return stdout.split(/\r?\n/).filter(Boolean).map(line => {
                const isDirectory = line.endsWith('/');
                const name = isDirectory ? line.slice(0, -1) : line.replace(/[*@]$/, '');
                if (name === '.' || name === '..' || name.startsWith('.')) return null;
                return { name, path: remotePath + name, isDirectory, size: 0, dateModified: 'Mobile File', type: isDirectory ? 'directory' : path.extname(name).toLowerCase() };
            }).filter(Boolean);
        } catch (e) { return { error: 'Could not access mobile storage.' }; }
    }
});

ipcMain.handle('transfer-file', async (event, sourcePath, destPath, sourceDeviceId, destDeviceId) => {
    try {
        if (!sourceDeviceId && destDeviceId) await execPromise(`adb -s ${destDeviceId} push "${sourcePath}" "${destPath}"`);
        else if (sourceDeviceId && !destDeviceId) await execPromise(`adb -s ${sourceDeviceId} pull "${sourcePath}" "${destPath}"`);
        else if (!sourceDeviceId && !destDeviceId) fs.copyFileSync(sourcePath, destPath);
        return { success: true };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('delete-file', async (event, targetPath, deviceId) => {
    try {
        if (!deviceId) {
            if (fs.lstatSync(targetPath).isDirectory()) fs.rmSync(targetPath, { recursive: true, force: true });
            else fs.unlinkSync(targetPath);
        } else {
            await execPromise(`adb -s ${deviceId} shell rm -rf "${targetPath}"`);
        }
        return { success: true };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('rename-file', async (event, targetPath, newName, deviceId) => {
    try {
        const dir = path.dirname(targetPath);
        const newPath = path.join(dir, newName).replace(/\\/g, '/');
        if (!deviceId) fs.renameSync(targetPath, newPath);
        else await execPromise(`adb -s ${deviceId} shell mv "${targetPath}" "${newPath}"`);
        return { success: true };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('get-mobile-preview', async (event, deviceId, remotePath) => {
    const ext = path.extname(remotePath).toLowerCase();
    const tempPath = path.join(tempDownloadsDir, `preview_${Date.now()}${ext}`);
    try {
        await execPromise(`adb -s ${deviceId} pull "${remotePath}" "${tempPath}"`);
        return tempPath;
    } catch (e) { return null; }
});

ipcMain.handle('get-info', async (event, url) => {
    if (!ytDlpWrap) return { error: 'Engine not ready.' };
    try {
        const metadata = await ytDlpWrap.getVideoInfo(url);
        if (metadata._type === 'playlist') {
            return {
                id: metadata.id, title: metadata.title, channel: metadata.uploader || 'Playlist',
                isPlaylist: true, entries: metadata.entries.map(e => ({ id: e.id, title: e.title, duration: e.duration, url: e.webpage_url || e.url }))
            };
        }
        return { id: metadata.id, title: metadata.title, thumbnail: metadata.thumbnail, duration: metadata.duration, channel: metadata.uploader, viewCount: metadata.view_count, isPlaylist: false };
    } catch (error) { return { error: 'Info error: ' + error.message }; }
});

ipcMain.on('start-download', async (event, url, format, startTime, endTime) => {
    if (!ytDlpWrap) return;
    try {
        const outputTemplate = path.join(tempDownloadsDir, `%(title)s.%(ext)s`);
        let args = [url, '-o', outputTemplate, '--no-part', '--no-continue'];
        
        if (format === 'mp3-320') {
            args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
        } else {
            args.push('--merge-output-format', 'mp4');
            // DEFINITIVE FIX: Always re-encode audio to AAC to ensure sound is merged correctly
            args.push('--postprocessor-args', 'ffmpeg: -c:a aac -b:a 192k');
            
            if (format === '4k') args.push('-f', 'bestvideo[height<=2160]+bestaudio/best');
            else if (format === '1080p') args.push('-f', 'bestvideo[height<=1080]+bestaudio/best');
            else if (format === '720p') args.push('-f', 'bestvideo[height<=720]+bestaudio/best');
        }

        if (startTime || endTime) {
            args.push('--download-sections', `*${startTime || 0}-${endTime || 'inf'}`);
            args.push('--force-keyframes-at-cuts');
        }

        // Use the absolute directory containing FFmpeg/FFprobe
        if (ffmpegPath) args.push('--ffmpeg-location', path.dirname(ffmpegPath));
        args.push('--js-runtimes', 'node');

        const downloader = ytDlpWrap.exec(args);
        currentDownloadProcess = downloader;

        downloader.on('progress', (progress) => { if (mainWindow) mainWindow.webContents.send('download-progress', progress); });
        downloader.on('error', (error) => { if (mainWindow) mainWindow.webContents.send('download-error', { error: error.message }); });

        downloader.on('close', (code) => {
            try {
                const files = fs.readdirSync(tempDownloadsDir);
                let moved = false;
                files.forEach(file => {
                    const oldPath = path.join(tempDownloadsDir, file);
                    const newPath = path.join(finalDownloadsDir, file);
                    const isTarget = (format === 'mp3-320' && file.endsWith('.mp3')) || (format !== 'mp3-320' && file.endsWith('.mp4'));
                    if (isTarget) { 
                        if (fs.existsSync(oldPath)) {
                            fs.renameSync(oldPath, newPath);
                            moved = true;
                        }
                    } else try { fs.unlinkSync(oldPath); } catch (e) {}
                });
                
                if (code === 0 && moved) {
                    if (mainWindow) mainWindow.webContents.send('download-completed');
                    if (process.platform === 'darwin') app.setBadgeCount(app.getBadgeCount() + 1);
                } else if (mainWindow) {
                    mainWindow.webContents.send('download-error', { 
                        error: code !== 0 ? `Download failed (Code ${code}).` : 'No valid output file was found.' 
                    });
                }
            } catch (e) { if (mainWindow) mainWindow.webContents.send('download-error', { error: 'Finalizing failed: ' + e.message }); }
        });
    } catch (e) { if (mainWindow) mainWindow.webContents.send('download-error', { error: e.message }); }
});

ipcMain.on('stop-download', () => { if (currentDownloadProcess) { currentDownloadProcess.kill(); currentDownloadProcess = null; } });

ipcMain.handle('select-file', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (!result.canceled && result.filePaths.length > 0) return { path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
    return null;
});

ipcMain.handle('trim-local-file', async (event, filePath, format, startTime, endTime) => {
    const ext = format.toLowerCase().includes('mp3') ? 'mp3' : 'mp4';
    const originalName = path.basename(filePath, path.extname(filePath));
    const outputName = `${originalName} Trimmed.${ext}`;
    const outputPath = path.join(finalDownloadsDir, outputName);
    
    return new Promise((resolve) => {
        if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return resolve({ error: 'Video Processor not found. Please wait for initialization.' });
        
        let args = ['-ss', startTime.toString(), '-to', endTime.toString(), '-i', filePath];
        if (ext === 'mp4') args.push('-c:v', 'copy', '-c:a', 'aac', '-strict', 'experimental');
        else args.push('-c', 'copy');
        args.push(outputPath);
        
        const proc = spawn(ffmpegPath, args);
        proc.on('close', (code) => {
            if (code === 0) resolve({ success: true, path: outputPath });
            else resolve({ error: 'Trimming failed (Error ' + code + ')' });
        });
        proc.on('error', (err) => resolve({ error: 'Trimmer start error: ' + err.message }));
    });
});

// --- APP READY ---

app.whenReady().then(async () => {
    try {
        userDataPath = app.getPath('userData');
        finalDownloadsDir = app.getPath('downloads');
        tempDownloadsDir = path.join(userDataPath, 'temp_downloads');
        binDir = path.join(userDataPath, 'bin');

        if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
        if (!fs.existsSync(tempDownloadsDir)) fs.mkdirSync(tempDownloadsDir, { recursive: true });

        try { require('fix-path')(); } catch (e) {}
        setupAutoUpdater();
        try { 
            const wrapModule = require('yt-dlp-wrap');
            YTDlpWrap = wrapModule.default || wrapModule;
        } catch (e) {}

        protocol.registerFileProtocol('media', (request, callback) => {
            const url = request.url.replace('media://', '');
            try { return callback(decodeURIComponent(url)); } catch (error) {}
        });

        // Initialize binaries BEFORE creating window
        createWindow();
        await ensureBinaries();

    } catch (err) { reportError('Critical Startup Error', err); }
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300, height: 850,
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#080b11',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    if (isDev) mainWindow.loadURL('http://localhost:5173').catch(() => mainWindow.loadFile(path.join(__dirname, '../frontend/dist/index.html')));
    else mainWindow.loadFile(path.join(__dirname, '../frontend/dist/index.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
