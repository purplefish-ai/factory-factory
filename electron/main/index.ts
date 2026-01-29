import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { ServerManager } from './server-manager';

let mainWindow: BrowserWindow | null = null;
const serverManager = new ServerManager();

async function createWindow() {
  const port = await serverManager.start();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${port}`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  await serverManager.stop();
  app.quit();
});
