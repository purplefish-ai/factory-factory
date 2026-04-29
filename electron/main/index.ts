import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { registerFatalErrorHandlers } from './fatal-error-handlers.js';
import { createElectronLifecycle } from './lifecycle.js';
import { ServerManager } from './server-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

registerFatalErrorHandlers({ app, dialog, logger: console, process });

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
