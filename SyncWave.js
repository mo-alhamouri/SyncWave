import { app, BrowserWindow } from 'electron';
import path from 'path';
import { createWindow } from './windowCreator';
import { setupAutoUpdater } from './updater';
import { init } from './init';

let mainWindow = null;

async function initializeApp() {
  try {
    await init();
    mainWindow = createWindow();
    if (!mainWindow) {
      console.error('Failed to create main window');
      app.exit(1);
    }
    mainWindow.show();
    setupAutoUpdater(mainWindow);
  } catch (err) {
    console.error('Error initializing SyncWave:', err);
    app.exit(1);
  }
}

app.whenReady().then(initializeApp);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

module.exports = { app };
