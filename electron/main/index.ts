import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { ServerManager } from './server-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
const serverManager = new ServerManager();

async function createWindow() {
  const url = await serverManager.start();

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
}

// IPC handler for native file/folder picker dialog
ipcMain.handle('dialog:showOpen', async (_event, options: Electron.OpenDialogOptions) => {
  if (!mainWindow) {
    return { canceled: true, filePaths: [] };
  }
  return await dialog.showOpenDialog(mainWindow, options);
});

app.whenReady().then(createWindow);

app.on('activate', () => {
  // On macOS, re-create window when dock icon is clicked and no windows are open
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('window-all-closed', async () => {
  await serverManager.stop();
  // On macOS, apps typically stay open until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
