const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // Info extraction
    getInfo: (url) => ipcRenderer.invoke('get-info', url),
    
    // Download process
    download: (url, format) => ipcRenderer.send('start-download', url, format),
    
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
    openDownloadsFolder: () => ipcRenderer.send('open-downloads-folder')
});
