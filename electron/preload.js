const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('electron', {
    // Info extraction
    getInfo: (url) => ipcRenderer.invoke('get-info', url),
    getEngineInfo: () => ipcRenderer.invoke('get-engine-info'),

    // Version & updates
    getVersion: () => ipcRenderer.invoke('get-version'),
    checkUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    quitAndInstall: () => ipcRenderer.send('quit-and-install'),
    onUpdateAvailable: on('update-available'),
    onUpdateProgress: on('update-progress'),
    onUpdateDownloaded: on('update-downloaded'),
    onUpdateError: on('update-error'),

    // Window controls
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    unmaximize: () => ipcRenderer.send('window-unmaximize'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

    // File operations
    openDownloads: () => ipcRenderer.send('open-downloads-folder'),
    selectFile: () => ipcRenderer.invoke('select-file'),
    // Path of a file dropped onto the window (drag & drop).
    getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return file && file.path; } },
    getWaveform: (path) => ipcRenderer.invoke('get-waveform', path),
    trimLocalFile: (path, format, start, end) => ipcRenderer.invoke('trim-local-file', path, format, start, end),
    clearBadge: () => ipcRenderer.send('clear-badge'),

    // Downloads
    download: (url, format, start, end) => ipcRenderer.send('start-download', url, format, start, end),
    stopDownload: () => ipcRenderer.send('stop-download'),
    onDownloadProgress: on('download-progress'),
    onDownloadCompleted: on('download-completed'),
    onDownloadError: on('download-error'),
    onDownloadStopped: on('download-stopped'),
    onInitStatus: on('init-status'),
});
