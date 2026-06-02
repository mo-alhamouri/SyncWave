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
    checkUpdates: () => ipcRenderer.invoke('check-for-updates')
});
