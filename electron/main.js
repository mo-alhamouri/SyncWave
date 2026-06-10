const { app, BrowserWindow, ipcMain, shell, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

// 1. ABSOLUTE TOP-LEVEL ERROR HANDLING
// We set this up before anything else can fail.
function reportError(title, error) {
    const message = error instanceof Error ? 
        `${error.message}\n\nStack:\n${error.stack}` : 
        `Non-Error thrown: ${JSON.stringify(error) || String(error)}`;
    
    console.error(title, error);
    
    // Fallback if dialog isn't ready
    if (dialog && dialog.showErrorBox) {
        dialog.showErrorBox(title, message);
    } else {
        console.error('CRITICAL: Dialog not available to show error.');
    }
}

process.on('uncaughtException', (error) => reportError('SyncWave Uncaught Exception', error));
process.on('unhandledRejection', (reason) => reportError('SyncWave Unhandled Rejection', reason));

// 2. DEFENSIVE REQUIRES & STATE
let isDev = false;
try {
    // Prefer native app.isPackaged over electron-is-dev for stability
    isDev = !app.isPackaged;
} catch (e) {
    console.warn('Could not determine isDev state, defaulting to false');
}

// Lazy-loaded dependencies to prevent startup crashes
let autoUpdater;
let ffmpeg;
let YTDlpWrap;
let fixPath;
let ytDlpWrap = null;

// Paths (initialized in app.whenReady)
let userDataPath, finalDownloadsDir, tempDownloadsDir, binDir, ytDlpPath;
let mainWindow = null;
let currentDownloadProcess = null;

// 3. APP INITIALIZATION
app.whenReady().then(async () => {
    try {
        console.log('App ready, starting initialization...');

        // Initialize Paths
        userDataPath = app.getPath('userData');
        finalDownloadsDir = app.getPath('downloads');
        tempDownloadsDir = path.join(userDataPath, 'temp_downloads');
        binDir = path.join(userDataPath, 'bin');
        ytDlpPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

        if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
        if (!fs.existsSync(tempDownloadsDir)) fs.mkdirSync(tempDownloadsDir, { recursive: true });

        // Load non-core dependencies safely
        try {
            fixPath = require('fix-path');
            fixPath();
        } catch (e) { console.error('fix-path failed:', e); }

        try {
            const updaterModule = require('electron-updater');
            autoUpdater = updaterModule.autoUpdater;
        } catch (e) { console.error('auto-updater load failed:', e); }

        try {
            ffmpeg = require('@ffmpeg-installer/ffmpeg');
        } catch (e) { console.error('ffmpeg-installer load failed:', e); }

        try {
            const wrapModule = require('yt-dlp-wrap');
            YTDlpWrap = wrapModule.default || wrapModule;
        } catch (e) { reportError('Dependency Load Error (yt-dlp-wrap)', e); }

        // Register media protocol
        protocol.registerFileProtocol('media', (request, callback) => {
            const url = request.url.replace('media://', '');
            try {
                return callback(decodeURIComponent(url));
            } catch (error) {
                console.error('Protocol error:', error);
            }
        });

        // Initialize yt-dlp binary
        await initYtdlp();

        // Create UI
        createWindow();

        // Check for updates
        if (!isDev && autoUpdater) {
            autoUpdater.checkForUpdatesAndNotify().catch(e => console.error('Update check failed:', e));
            setupUpdaterEvents();
        }

    } catch (err) {
        reportError('Initialization Failed', err);
    }
});

// --- HELPER FUNCTIONS ---

async function initYtdlp() {
    if (!YTDlpWrap) return;
    try {
        if (!fs.existsSync(ytDlpPath)) {
            console.log('yt-dlp missing, downloading...');
            await downloadStandaloneYtdlp(ytDlpPath);
        }
        ytDlpWrap = new YTDlpWrap(ytDlpPath);
    } catch (error) {
        reportError('yt-dlp Initialization Error', error);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 850,
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#080b11',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173').catch(e => {
            console.error('Failed to load dev URL:', e);
            mainWindow.loadFile(path.join(__dirname, '../frontend/dist/index.html'));
        });
    } else {
        mainWindow.loadFile(path.join(__dirname, '../frontend/dist/index.html')).catch(e => {
            reportError('Failed to load UI file', e);
        });
    }

    mainWindow.on('closed', () => { mainWindow = null; });
}

function downloadStandaloneYtdlp(dest) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        let downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
        if (process.platform === 'darwin') downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
        else if (process.platform === 'win32') downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

        const file = fs.createWriteStream(dest);
        const download = (url) => {
            https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    download(response.headers.location);
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`Server returned status ${response.statusCode}`));
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
        download(downloadUrl);
    });
}

function setupUpdaterEvents() {
    if (!autoUpdater) return;
    autoUpdater.on('update-available', (info) => {
        if (mainWindow) mainWindow.webContents.send('update-available', info);
    });
    autoUpdater.on('update-downloaded', (info) => {
        if (mainWindow) mainWindow.webContents.send('update-downloaded', info);
    });
}

// --- IPC HANDLERS ---

ipcMain.on('quit-and-install', () => {
    if (autoUpdater) autoUpdater.quitAndInstall();
});

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow && mainWindow.maximize());
ipcMain.on('window-unmaximize', () => mainWindow && mainWindow.unmaximize());
ipcMain.handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);

ipcMain.on('open-downloads-folder', () => shell.openPath(finalDownloadsDir));
ipcMain.on('clear-badge', () => { if (process.platform === 'darwin') app.setBadgeCount(0); });

ipcMain.handle('get-info', async (event, url) => {
    if (!ytDlpWrap) return { error: 'yt-dlp not initialized' };
    try {
        const metadata = await ytDlpWrap.getVideoInfo(url);
        if (metadata._type === 'playlist') {
            return {
                id: metadata.id,
                title: metadata.title,
                channel: metadata.uploader || 'Playlist',
                isPlaylist: true,
                entries: metadata.entries.map(e => ({ id: e.id, title: e.title, duration: e.duration }))
            };
        }
        return {
            id: metadata.id,
            title: metadata.title,
            thumbnail: metadata.thumbnail,
            duration: metadata.duration,
            channel: metadata.uploader,
            viewCount: metadata.view_count,
            isPlaylist: false
        };
    } catch (error) {
        return { error: 'Could not extract info: ' + (error.message || 'Unknown error') };
    }
});

ipcMain.on('start-download', async (event, url, format, startTime, endTime) => {
    if (!ytDlpWrap) return;
    try {
        const outputTemplate = path.join(tempDownloadsDir, `%(title)s.%(ext)s`);
        let args = [url, '-o', outputTemplate];
        
        if (format === 'mp3-320') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
        else if (format === '4k') args.push('-f', 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best');
        else if (format === '1080p') args.push('-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best');
        else if (format === '720p') args.push('-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best');

        if (startTime || endTime) {
            args.push('--download-sections', `*${startTime || 0}-${endTime || 'inf'}`);
            // Use --force-keyframes-at-cuts for more precise trimming during download
            args.push('--force-keyframes-at-cuts');
        }

        // Fix: Explicitly provide FFmpeg location to yt-dlp
        if (ffmpeg && ffmpeg.path) {
            args.push('--ffmpeg-location', ffmpeg.path);
        }

        // Fix: Use node as the JS runtime if available
        args.push('--js-runtimes', 'node');

        const downloader = ytDlpWrap.exec(args);
        currentDownloadProcess = downloader;

        downloader.on('progress', (progress) => {
            if (mainWindow) mainWindow.webContents.send('download-progress', progress);
        });

        downloader.on('error', (error) => {
            if (mainWindow) mainWindow.webContents.send('download-error', { error: error.message });
        });

        downloader.on('close', () => {
            try {
                const files = fs.readdirSync(tempDownloadsDir);
                files.forEach(file => {
                    const oldPath = path.join(tempDownloadsDir, file);
                    const newPath = path.join(finalDownloadsDir, file);
                    if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
                });
                if (mainWindow) mainWindow.webContents.send('download-completed');
                if (process.platform === 'darwin') app.setBadgeCount(app.getBadgeCount() + 1);
            } catch (e) { console.error('Post-download rename failed:', e); }
        });
    } catch (e) {
        if (mainWindow) mainWindow.webContents.send('download-error', { error: e.message });
    }
});

ipcMain.on('stop-download', () => {
    if (currentDownloadProcess) {
        currentDownloadProcess.kill();
        currentDownloadProcess = null;
    }
});

ipcMain.handle('select-file', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        return { path: filePath, name: path.basename(filePath) };
    }
    return null;
});

ipcMain.handle('trim-local-file', async (event, filePath, format, startTime, endTime) => {
    const { spawn } = require('child_process');
    const outputName = `trimmed_${Date.now()}.${format.startsWith('mp3') ? 'mp3' : 'mp4'}`;
    const outputPath = path.join(finalDownloadsDir, outputName);
    
    return new Promise((resolve) => {
        if (!ffmpeg || !ffmpeg.path) {
            return resolve({ error: 'FFmpeg not available' });
        }
        let args = ['-i', filePath, '-ss', startTime.toString(), '-to', endTime.toString(), '-c', 'copy', outputPath];
        const proc = spawn(ffmpeg.path, args);
        proc.on('close', (code) => {
            if (code === 0) resolve({ success: true, path: outputPath });
            else resolve({ error: 'FFmpeg failed with code ' + code });
        });
        proc.on('error', (err) => resolve({ error: 'FFmpeg spawn error: ' + err.message }));
    });
});

ipcMain.handle('list-devices', async () => {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    async function getAdbPath() {
        const locations = ['adb', path.join(app.getPath('home'), 'Library/Android/sdk/platform-tools/adb'), '/usr/local/bin/adb', '/opt/homebrew/bin/adb', path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk/platform-tools/adb.exe'), 'C:\\platform-tools\\adb.exe'];
        for (const loc of locations) {
            try {
                const { stdout } = await execPromise(`"${loc}" version`);
                if (stdout.includes('Android Debug Bridge')) return loc;
            } catch (e) {}
        }
        return null;
    }

    const adbPath = await getAdbPath();
    const devices = [];
    if (adbPath) {
        try {
            await execPromise(`"${adbPath}" start-server`);
            const { stdout } = await execPromise(`"${adbPath}" devices`);
            const lines = stdout.split('\n');
            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].trim().split(/\s+/);
                if (parts.length >= 2 && parts[1] === 'device') {
                    devices.push({ id: parts[0], name: `Android Phone (${parts[0]})`, type: 'android' });
                }
            }
        } catch (e) {}
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
                    return { 
                        name: entry.name, 
                        path: fullPath, 
                        isDirectory: entry.isDirectory(), 
                        size: stats.size, 
                        dateModified: stats.mtime, 
                        type: entry.isDirectory() ? 'directory' : path.extname(entry.name).toLowerCase() 
                    };
                } catch (e) { return null; }
            }).filter(Boolean);
        } catch (e) { return { error: e.message }; }
    } else {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        
        async function getAdbPath() {
            const locations = ['adb', path.join(app.getPath('home'), 'Library/Android/sdk/platform-tools/adb'), '/usr/local/bin/adb', '/opt/homebrew/bin/adb', path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk/platform-tools/adb.exe'), 'C:\\platform-tools\\adb.exe'];
            for (const loc of locations) {
                try {
                    const { stdout } = await execPromise(`"${loc}" version`);
                    if (stdout.includes('Android Debug Bridge')) return loc;
                } catch (e) {}
            }
            return null;
        }

        const adbPath = await getAdbPath();
        if (!adbPath) return { error: 'ADB not found' };
        let remotePath = (targetPath || '/sdcard').replace(/\/+/g, '/');
        if (!remotePath.endsWith('/')) remotePath += '/';
        try {
            const { stdout } = await execPromise(`"${adbPath}" -s ${deviceId} shell ls -1F "${remotePath}"`);
            return stdout.split(/\r?\n/).filter(Boolean).map(line => {
                const isDirectory = line.endsWith('/');
                const name = isDirectory ? line.slice(0, -1) : line.replace(/[*@]$/, '');
                if (name === '.' || name === '..' || name.startsWith('.')) return null;
                return { 
                    name, 
                    path: remotePath + name, 
                    isDirectory, 
                    size: 0, 
                    dateModified: 'Mobile File', 
                    type: isDirectory ? 'directory' : path.extname(name).toLowerCase() 
                };
            }).filter(Boolean);
        } catch (e) { return { error: 'Could not access mobile storage.' }; }
    }
});

ipcMain.handle('transfer-file', async (event, sourcePath, destPath, sourceDeviceId, destDeviceId) => {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    async function getAdbPath() {
        const locations = ['adb', path.join(app.getPath('home'), 'Library/Android/sdk/platform-tools/adb'), '/usr/local/bin/adb', '/opt/homebrew/bin/adb', path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk/platform-tools/adb.exe'), 'C:\\platform-tools\\adb.exe'];
        for (const loc of locations) {
            try {
                const { stdout } = await execPromise(`"${loc}" version`);
                if (stdout.includes('Android Debug Bridge')) return loc;
            } catch (e) {}
        }
        return null;
    }

    const adbPath = await getAdbPath();
    try {
        if (!sourceDeviceId && destDeviceId) await execPromise(`"${adbPath}" -s ${destDeviceId} push "${sourcePath}" "${destPath}"`);
        else if (sourceDeviceId && !destDeviceId) await execPromise(`"${adbPath}" -s ${sourceDeviceId} pull "${sourcePath}" "${destPath}"`);
        else if (!sourceDeviceId && !destDeviceId) fs.copyFileSync(sourcePath, destPath);
        return { success: true };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('delete-file', async (event, targetPath, deviceId) => {
    try {
        if (!deviceId) {
            if (fs.lstatSync(targetPath).isDirectory()) {
                fs.rmSync(targetPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(targetPath);
            }
        } else {
            const { exec } = require('child_process');
            const util = require('util');
            const execPromise = util.promisify(exec);
            const adbPath = 'adb'; // Simplification for now, should use getAdbPath
            await execPromise(`"${adbPath}" -s ${deviceId} shell rm -rf "${targetPath}"`);
        }
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('rename-file', async (event, targetPath, newName, deviceId) => {
    try {
        const dir = path.dirname(targetPath);
        const newPath = path.join(dir, newName).replace(/\\/g, '/');
        
        if (!deviceId) {
            fs.renameSync(targetPath, newPath);
        } else {
            const { exec } = require('child_process');
            const util = require('util');
            const execPromise = util.promisify(exec);
            const adbPath = 'adb';
            await execPromise(`"${adbPath}" -s ${deviceId} shell mv "${targetPath}" "${newPath}"`);
        }
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('get-mobile-preview', async (event, deviceId, remotePath) => {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // Minimal Adb search for this specific handler
    const adbPath = 'adb'; 
    const ext = path.extname(remotePath).toLowerCase();
    const tempPath = path.join(tempDownloadsDir, `preview_${Date.now()}${ext}`);
    try {
        await execPromise(`"${adbPath}" -s ${deviceId} pull "${remotePath}" "${tempPath}"`);
        return tempPath;
    } catch (e) { return null; }
});

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

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

