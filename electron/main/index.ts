import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  Menu,
  nativeTheme,
  screen,
  shell,
} from 'electron';
import { createDesktopShell } from './desktop-shell.js';
import { registerFatalErrorHandlers } from './fatal-error-handlers.js';
import { createElectronLifecycle } from './lifecycle.js';
import { ignoreOutputStreamErrors } from './output-pipes.js';
import { ServerManager } from './server-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

ignoreOutputStreamErrors([process.stdout, process.stderr]);

const serverManager = new ServerManager();
registerFatalErrorHandlers({ app, dialog, logger: console, process, serverManager });
const desktopShell = createDesktopShell({
  statePath: path.join(app.getPath('userData'), 'window-state.json'),
  nativeTheme,
  menu: Menu,
  isPackaged: app.isPackaged,
  platform: process.platform,
  screen,
  logger: console,
  onCommand: (command) => {
    void lifecycle.dispatchAppCommand(command).catch((error: unknown) => {
      console.error('[electron] Could not run app command:', error);
    });
  },
});
const lifecycle = createElectronLifecycle({
  app,
  desktopShell,
  browserWindow: BrowserWindow,
  clipboard,
  nativeImage,
  dialog,
  ipcMain,
  logger: console,
  platform: process.platform,
  preloadPath: path.join(__dirname, '../preload/index.cjs'),
  serverManager,
  shell,
});

lifecycle.registerIpcHandlers();
lifecycle.registerAppHandlers();
lifecycle.start();
