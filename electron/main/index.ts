import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { createElectronLifecycle } from './lifecycle.js';
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

const serverManager = new ServerManager();
const lifecycle = createElectronLifecycle({
  app,
  browserWindow: BrowserWindow,
  dialog,
  ipcMain,
  logger: console,
  platform: process.platform,
  preloadPath: path.join(__dirname, '../preload/index.js'),
  serverManager,
});

lifecycle.registerIpcHandlers();
lifecycle.registerAppHandlers();
lifecycle.start();
