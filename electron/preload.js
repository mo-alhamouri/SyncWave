const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // Info extraction
    getInfo: (url) => ipcRenderer.invoke('get-info', url),
    
    // Waveform generation
    getWaveform: () => ipcRenderer.invoke('get-waveform'),

    // Version & Updates
    getVersion: () => ipcRenderer.invoke('get-version'),
    checkUpdates: () => ipcRenderer.invoke('check-for-updates'),
    
    // Window controls
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    unmaximize: () => ipcRenderer.send('window-unmaximize'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    
    // File operations
    openDownloads: () => ipcRenderer.send('open-downloads-folder'),
    selectFile: () => ipcRenderer.invoke('select-file'),
    trimLocalFile: (path, format, start, end) => ipcRenderer.invoke('trim-local-file', path, format, start, end),
    clearBadge: () => ipcRenderer.send('clear-badge'),
    
    // Mobile Transfer
    listDevices: () => ipcRenderer.invoke('list-devices'),
    listLocalVolumes: () => ipcRenderer.invoke('list-local-volumes'),
    listFiles: (path, deviceId) => ipcRenderer.invoke('list-files', path, deviceId),
    transferFile: (source, dest, sourceId, destId) => ipcRenderer.invoke('transfer-file', source, dest, sourceId, destId),
    deleteFile: (path, deviceId) => ipcRenderer.invoke('delete-file', path, deviceId),
    renameFile: (path, newName, deviceId) => ipcRenderer.invoke('rename-file', path, newName, deviceId),
    getMobilePreview: (deviceId, path) => ipcRenderer.invoke('get-mobile-preview', deviceId, path),

    // Download events
    download: (url, format) => ipcRenderer.send('start-download', url, format),
    stopDownload: () => ipcRenderer.send('stop-download'),
    onDownloadProgress: (callback) => {
        const listener = (event, data) => callback(data);
        ipcRenderer.on('download-progress', listener);
        return () => ipcRenderer.removeListener('download-progress', listener);
    },
    onDownloadCompleted: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('download-completed', listener);
        return () => ipcRenderer.removeListener('download-completed', listener);
    },
    onDownloadError: (callback) => {
        const listener = (event, data) => callback(data);
        ipcRenderer.on('download-error', listener);
        return () => ipcRenderer.removeListener('download-error', listener);
    },
    onInitStatus: (callback) => {
        const listener = (event, msg) => callback(msg);
        ipcRenderer.on('init-status', listener);
        return () => ipcRenderer.removeListener('init-status', listener);
    },
    onUpdateAvailable: (callback) => {
        const listener = (event, info) => callback(info);
        ipcRenderer.on('update-available', listener);
        return () => ipcRenderer.removeListener('update-available', listener);
    },
    onUpdateDownloaded: (callback) => {
        const listener = (event, info) => callback(info);
        ipcRenderer.on('update-downloaded', listener);
        return () => ipcRenderer.removeListener('update-downloaded', listener);
    },
    quitAndInstall: () => ipcRenderer.send('quit-and-install')
});
