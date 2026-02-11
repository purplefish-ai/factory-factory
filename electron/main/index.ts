import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { ServerManager } from './server-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Catch unhandled errors that could cause silent crashes
process.on('uncaughtException', (error) => {
  console.error('[electron] Uncaught exception:', error);
  dialog.showErrorBox('Uncaught Exception', error.stack || String(error));
});

process.on('unhandledRejection', (reason) => {
  console.error('[electron] Unhandled rejection:', reason);
  dialog.showErrorBox('Unhandled Rejection', String(reason));
});

let mainWindow: BrowserWindow | null = null;
const serverManager = new ServerManager();

async function createWindow() {
  try {
    console.log('[electron] Starting createWindow...');
    console.log('[electron] __dirname:', __dirname);
    console.log('[electron] process.resourcesPath:', process.resourcesPath);
    console.log('[electron] process.cwd():', process.cwd());

    const url = await serverManager.start();
    console.log('[electron] Server started, URL:', url);

    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    mainWindow.loadURL(url);
    console.log('[electron] Window created and URL loaded');

    // Track window focus state for notifications
    mainWindow.on('focus', () => {
      mainWindow?.webContents.send('window-focus-changed', true);
    });

    mainWindow.on('blur', () => {
      mainWindow?.webContents.send('window-focus-changed', false);
    });
  } catch (error) {
    console.error('[electron] Failed to create window:', error);
    dialog.showErrorBox(
      'Startup Error',
      `Failed to start application:\n\n${error instanceof Error ? error.stack : String(error)}`
    );
    app.quit();
  }
}

// IPC handler for native file/folder picker dialog
ipcMain.handle('dialog:showOpen', async (_event, options: Electron.OpenDialogOptions) => {
  if (!mainWindow) {
    return { canceled: true, filePaths: [] };
  }
  return await dialog.showOpenDialog(mainWindow, options);
});

console.log('[electron] App starting, waiting for ready...');

app
  .whenReady()
  .then(() => {
    console.log('[electron] App ready, creating window...');
    return createWindow();
  })
  .catch((error) => {
    console.error('[electron] Fatal error during startup:', error);
    dialog.showErrorBox(
      'Fatal Startup Error',
      `Application failed to start:\n\n${error instanceof Error ? error.stack : String(error)}`
    );
    app.quit();
  });

app.on('activate', () => {
  // On macOS, re-create window when dock icon is clicked and no windows are open
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on('window-all-closed', async () => {
  await serverManager.stop();
  // On macOS, apps typically stay open until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
