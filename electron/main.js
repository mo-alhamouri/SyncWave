const { app, BrowserWindow, ipcMain, shell, dialog, protocol } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const isDev = require('electron-is-dev');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const { spawn } = require('child_process');
const fixPath = require('fix-path');

// Fix the $PATH on macOS
fixPath();

// Register media protocol for local file preview
app.whenReady().then(() => {
    protocol.registerFileProtocol('media', (request, callback) => {
        const url = request.url.replace('media://', '');
        try {
            return callback(decodeURIComponent(url));
        } catch (error) {
            console.error(error);
        }
    });
});

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

if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
if (!fs.existsSync(tempDownloadsDir)) fs.mkdirSync(tempDownloadsDir, { recursive: true });

const https = require('https');

function downloadStandaloneYtdlp(dest) {
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
        if (!fs.existsSync(ytDlpPath)) await downloadStandaloneYtdlp(ytDlpPath);
        ytDlpWrap = new YTDlpWrap(ytDlpPath);
    } catch (error) {
        console.error('Failed to initialize yt-dlp:', error);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 850,
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    if (isDev) mainWindow.loadURL('http://localhost:5173');
    else mainWindow.loadFile(path.join(__dirname, '../frontend/dist/index.html'));

    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
    await initYtdlp();
    createWindow();
    
    // Auto-update check after launch
    if (!isDev) {
        autoUpdater.checkForUpdatesAndNotify();
    }
});

// --- Auto-Updater Events ---
autoUpdater.on('update-available', (info) => {
    if (mainWindow) {
        mainWindow.webContents.send('update-available', info);
    }
});

autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) {
        mainWindow.webContents.send('update-downloaded', info);
    }
});

ipcMain.on('quit-and-install', () => {
    autoUpdater.quitAndInstall();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.handle('get-info', async (event, url) => {
    try {
        const metadata = await ytDlpWrap.getVideoInfo(url);
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
        } catch (e) {}
        return { error: 'Could not extract info.' };
    }
});

ipcMain.handle('get-waveform', async () => {
    return Array.from({ length: 100 }, () => Math.random());
});

ipcMain.on('start-download', async (event, url, format, startTime, endTime) => {
    try {
        const extension = format.startsWith('mp3') ? 'mp3' : 'mp4';
        const outputTemplate = path.join(tempDownloadsDir, `%(title)s.%(ext)s`);
        
        let args = [url, '-o', outputTemplate];
        if (format === 'mp3-320') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
        else if (format === '4k') args.push('-f', 'bestvideo[height<=2160]+bestaudio/best');
        else if (format === '1080p') args.push('-f', 'bestvideo[height<=1080]+bestaudio/best');
        else if (format === '720p') args.push('-f', 'bestvideo[height<=720]+bestaudio/best');

        if (startTime || endTime) {
            args.push('--download-sections', `*${startTime || 0}-${endTime || 'inf'}`);
        }

        const downloader = ytDlpWrap.exec(args);
        currentDownloadProcess = downloader;

        downloader.on('progress', (progress) => {
            mainWindow.webContents.send('download-progress', progress);
        });

        downloader.on('error', (error) => {
            mainWindow.webContents.send('download-error', { error: error.message });
        });

        downloader.on('close', () => {
            const files = fs.readdirSync(tempDownloadsDir);
            files.forEach(file => {
                const oldPath = path.join(tempDownloadsDir, file);
                const newPath = path.join(finalDownloadsDir, file);
                if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
            });
            mainWindow.webContents.send('download-completed');
            if (process.platform === 'darwin') app.setBadgeCount(app.getBadgeCount() + 1);
        });
    } catch (e) {
        mainWindow.webContents.send('download-error', { error: e.message });
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
    const outputName = `trimmed_${Date.now()}.${format.startsWith('mp3') ? 'mp3' : 'mp4'}`;
    const outputPath = path.join(finalDownloadsDir, outputName);
    return new Promise((resolve) => {
        let args = ['-i', filePath, '-ss', startTime.toString(), '-to', endTime.toString(), '-c', 'copy', outputPath];
        const proc = spawn(ffmpeg.path, args);
        proc.on('close', (code) => {
            if (code === 0) resolve({ success: true, path: outputPath });
            else resolve({ error: 'FFmpeg failed' });
        });
    });
});

ipcMain.handle('check-for-updates', async () => {
    const result = await autoUpdater.checkForUpdates();
    return result ? { version: result.updateInfo.version } : null;
});

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.on('open-downloads-folder', () => shell.openPath(finalDownloadsDir));
ipcMain.on('clear-badge', () => { if (process.platform === 'darwin') app.setBadgeCount(0); });

// --- Window Controls ---
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow.maximize());
ipcMain.on('window-unmaximize', () => mainWindow.unmaximize());
ipcMain.handle('window-is-maximized', () => mainWindow.isMaximized());

// --- Mobile Transfer ---

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

ipcMain.handle('list-devices', async () => {
    const adbPath = await getAdbPath();
    const devices = [];
    if (adbPath) {
        try {
            await execPromise(`"${adbPath}" start-server`);
            const { stdout } = await execPromise(`"${adbPath}" devices`);
            const lines = stdout.split('\n');
            for (let i = 1; i < lines.length; i++) {
                const [id, status] = lines[i].trim().split(/\s+/);
                if (id && status === 'device') devices.push({ id, name: `Android Phone (${id})`, type: 'android' });
            }
        } catch (e) {}
    }
    return devices;
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
    } else if (process.platform === 'win32') {
        try {
            const { stdout } = await execPromise('wmic logicaldisk get name');
            const drives = stdout.split('\n').slice(1).map(d => d.trim()).filter(Boolean);
            drives.forEach(d => {
                volumes.push({ name: `Drive ${d}`, path: d + '\\', type: 'external' });
            });
        } catch (e) {}
    }

    return volumes;
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
                return { name, path: remotePath + name, isDirectory, size: 0, dateModified: 'Mobile File', type: isDirectory ? 'directory' : path.extname(name).toLowerCase() };
            }).filter(Boolean);
        } catch (e) { return { error: 'Could not access mobile storage.' }; }
    }
});

ipcMain.handle('transfer-file', async (event, sourcePath, destPath, sourceDeviceId, destDeviceId) => {
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
            const adbPath = await getAdbPath();
            if (!adbPath) throw new Error('ADB not found');
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
            const adbPath = await getAdbPath();
            if (!adbPath) throw new Error('ADB not found');
            // adb shell mv requires full source and dest paths
            await execPromise(`"${adbPath}" -s ${deviceId} shell mv "${targetPath}" "${newPath}"`);
        }
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('get-mobile-preview', async (event, deviceId, remotePath) => {
    const adbPath = await getAdbPath();
    if (!adbPath) return null;
    const ext = path.extname(remotePath).toLowerCase();
    const tempPath = path.join(tempDownloadsDir, `preview_${Date.now()}${ext}`);
    try {
        await execPromise(`"${adbPath}" -s ${deviceId} pull "${remotePath}" "${tempPath}"`);
        return tempPath;
    } catch (e) { return null; }
});
