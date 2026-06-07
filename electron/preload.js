const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // Info extraction
    getInfo: (url) => ipcRenderer.invoke('get-info', url),
    
    // Waveform generation
    getWaveform: (url) => ipcRenderer.invoke('get-waveform', url),
    
    // Download process with trim support
    download: (url, format, startTime, endTime) => ipcRenderer.send('start-download', url, format, startTime, endTime),
    
    // Listen for progress updates
    onDownloadProgress: (callback) => {
        const subscription = (event, data) => callback(data);
        ipcRenderer.on('download-progress', subscription);
        return () => ipcRenderer.removeListener('download-progress', subscription);
    },
    
    // Listen for completion
    onDownloadCompleted: (callback) => {
        const subscription = (event, data) => callback(data);
        ipcRenderer.on('download-completed', subscription);
        return () => ipcRenderer.removeListener('download-completed', subscription);
    },
    
    // Listen for errors
    onDownloadError: (callback) => {
        const subscription = (event, data) => callback(data);
        ipcRenderer.on('download-error', subscription);
        return () => ipcRenderer.removeListener('download-error', subscription);
    },
    
    // Stop process
    stopDownload: () => ipcRenderer.send('stop-download'),
    
    // Open downloads folder
    openDownloadsFolder: () => ipcRenderer.send('open-downloads-folder'),

    // Clear dock badge
    clearBadge: () => ipcRenderer.send('clear-badge'),

    // Version & Updates
    getVersion: () => ipcRenderer.invoke('get-version'),
    checkUpdates: () => ipcRenderer.invoke('check-for-updates'),

    // Local File Trimmer
    selectFile: () => ipcRenderer.invoke('select-file'),
    trimLocalFile: (filePath, format, startTime, endTime) => ipcRenderer.invoke('trim-local-file', filePath, format, startTime, endTime),

    // Mobile Transfer
    listDevices: () => ipcRenderer.invoke('list-devices'),
    listLocalVolumes: () => ipcRenderer.invoke('list-local-volumes'),
    listFiles: (path, deviceId) => ipcRenderer.invoke('list-files', path, deviceId),
    getMobilePreview: (deviceId, remotePath) => ipcRenderer.invoke('get-mobile-preview', deviceId, remotePath),
    transferFile: (sourcePath, destPath, sourceDeviceId, destDeviceId) => ipcRenderer.invoke('transfer-file', sourcePath, destPath, sourceDeviceId, destDeviceId),
    renameFile: (path, newName, deviceId) => ipcRenderer.invoke('rename-file', path, newName, deviceId),
    deleteFile: (path, deviceId) => ipcRenderer.invoke('delete-file', path, deviceId),

    // Window Controls
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    unmaximize: () => ipcRenderer.send('window-unmaximize'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

    // Auto-updates
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
