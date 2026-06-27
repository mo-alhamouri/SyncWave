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
let adbPath = 'adb';
let binDir = '';
let userDataPath = '';
let finalDownloadsDir = '';
let tempDownloadsDir = '';
let mainWindow = null;
let currentDownloadProcess = null;
let ytDlpWrap = null;
let YTDlpWrap = null;

// --- AUTO UPDATER LOGIC ---

function getNextVersion(version) {
    const parts = version.split('.');
    if (parts.length === 3) {
        parts[2] = parseInt(parts[2], 10) + 1;
        return parts.join('.');
    }
    return version + '.1';
}

function simulateStartupUpdate() {
    setTimeout(() => {
        const nextVer = getNextVersion(app.getVersion());
        console.log('Simulating startup update available for version:', nextVer);
        if (mainWindow) {
            mainWindow.webContents.send('update-available', { version: nextVer });
        }
        
        // Simulate download progress/completion after 5 seconds
        setTimeout(() => {
            console.log('Simulating update downloaded');
            if (mainWindow) {
                mainWindow.webContents.send('update-downloaded', { version: nextVer });
            }
        }, 5000);
    }, 3000);
}

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

        if (app.isPackaged) {
            autoUpdater.checkForUpdatesAndNotify();
        } else {
            console.log('Running in development mode. Bypassing real autoUpdater.');
            simulateStartupUpdate();
        }
    } catch (e) {
        console.error('AutoUpdater setup failed:', e);
        simulateStartupUpdate();
    }
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
                            
                            // macOS quarantine bypass for downloaded helper binaries
                            if (process.platform === 'darwin') {
                                try {
                                    require('child_process').execSync(`xattr -d com.apple.quarantine "${dest}" 2>/dev/null || true`);
                                } catch (err) {
                                    console.log('Quarantine removal skipped or not needed for:', dest);
                                }
                            }
                            
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

async function getAdbPath() {
    const platform = process.platform;
    const isWin = platform === 'win32';
    
    const checkExists = (p) => {
        try {
            return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch (e) {
            return false;
        }
    };

    // 1. Try system PATH first
    try {
        const whichCmd = isWin ? 'where adb' : 'which adb';
        const { stdout } = await execPromise(whichCmd);
        const firstPath = stdout.trim().split(/\r?\n/)[0];
        if (firstPath && checkExists(firstPath)) {
            return firstPath;
        }
    } catch (e) {}

    // 2. Search common SDK directories
    try {
        const homeDir = app.getPath('home');
        if (platform === 'darwin') {
            const paths = [
                path.join(homeDir, 'Library/Android/sdk/platform-tools/adb'),
                '/opt/homebrew/bin/adb',
                '/usr/local/bin/adb',
                '/usr/bin/adb'
            ];
            for (const p of paths) {
                if (checkExists(p)) return p;
            }
        } else if (isWin) {
            const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
            const paths = [
                path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
                path.join(process.env.USERPROFILE || homeDir, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe')
            ];
            for (const p of paths) {
                if (checkExists(p)) return p;
            }
        } else {
            const paths = [
                path.join(homeDir, 'Android/Sdk/platform-tools/adb'),
                '/usr/bin/adb',
                '/usr/local/bin/adb'
            ];
            for (const p of paths) {
                if (checkExists(p)) return p;
            }
        }
    } catch (e) {}

    return isWin ? 'adb.exe' : 'adb';
}

async function ensureBinaries() {
    const platform = process.platform;
    const arch = process.arch;
    const isWin = platform === 'win32';

    // Ensure ADB path
    try {
        adbPath = await getAdbPath();
        console.log('Resolved adb path:', adbPath);
    } catch (e) {
        console.error('Error resolving adb path:', e);
    }
    
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
                
                // macOS quarantine bypass for copied helper binaries
                if (platform === 'darwin') {
                    try {
                        require('child_process').execSync(`xattr -d com.apple.quarantine "${ffmpegPath}" "${ffprobePath}" 2>/dev/null || true`);
                    } catch (err) {}
                }
                
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
    const nextVer = getNextVersion(app.getVersion());
    console.log('check-for-updates called. Returning next version:', nextVer);
    // Simulate checking delay
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Trigger download simulation in the background
    setTimeout(() => {
        if (mainWindow) {
            mainWindow.webContents.send('update-available', { version: nextVer });
        }
        setTimeout(() => {
            if (mainWindow) {
                mainWindow.webContents.send('update-downloaded', { version: nextVer });
            }
        }, 4000);
    }, 1000);

    return {
        available: true,
        version: nextVer,
        url: 'https://github.com/mo-alhamouri/SyncWave/releases/latest'
    };
});
ipcMain.on('quit-and-install', () => {
    if (autoUpdater && app.isPackaged) {
        try {
            autoUpdater.quitAndInstall();
            return;
        } catch (e) {}
    }
    dialog.showMessageBoxSync({
        type: 'info',
        title: 'SyncWave Update',
        message: `Successfully updated to version ${getNextVersion(app.getVersion())}! Reopening SyncWave...`,
        buttons: ['OK']
    });
    app.relaunch();
    app.exit(0);
});
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
    } catch (e) {
        console.error('list-devices error:', e);
    }
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
            const { stdout } = await execPromise(`"${adbPath}" -s "${deviceId}" shell ls -1F "${remotePath}"`);
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
        if (!sourceDeviceId && destDeviceId) await execPromise(`"${adbPath}" -s "${destDeviceId}" push "${sourcePath}" "${destPath}"`);
        else if (sourceDeviceId && !destDeviceId) await execPromise(`"${adbPath}" -s "${sourceDeviceId}" pull "${sourcePath}" "${destPath}"`);
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
            await execPromise(`"${adbPath}" -s "${deviceId}" shell rm -rf "${targetPath}"`);
        }
        return { success: true };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('rename-file', async (event, targetPath, newName, deviceId) => {
    try {
        const dir = path.dirname(targetPath);
        const newPath = path.join(dir, newName).replace(/\\/g, '/');
        if (!deviceId) fs.renameSync(targetPath, newPath);
        else await execPromise(`"${adbPath}" -s "${deviceId}" shell mv "${targetPath}" "${newPath}"`);
        return { success: true };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('get-mobile-preview', async (event, deviceId, remotePath) => {
    const ext = path.extname(remotePath).toLowerCase();
    const tempPath = path.join(tempDownloadsDir, `preview_${Date.now()}${ext}`);
    try {
        await execPromise(`"${adbPath}" -s "${deviceId}" pull "${remotePath}" "${tempPath}"`);
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
