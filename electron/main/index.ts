import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage } from 'electron';
import { registerFatalErrorHandlers } from './fatal-error-handlers.js';
import { createElectronLifecycle } from './lifecycle.js';
import { ignoreOutputStreamErrors } from './output-pipes.js';
import { ServerManager } from './server-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

ignoreOutputStreamErrors([process.stdout, process.stderr]);

const serverManager = new ServerManager();
registerFatalErrorHandlers({ app, dialog, logger: console, process, serverManager });
const lifecycle = createElectronLifecycle({
  app,
  browserWindow: BrowserWindow,
  clipboard,
  nativeImage,
  dialog,
  ipcMain,
  logger: console,
  platform: process.platform,
  preloadPath: path.join(__dirname, '../preload/index.cjs'),
  serverManager,
});

lifecycle.registerIpcHandlers();
lifecycle.registerAppHandlers();
lifecycle.start();
