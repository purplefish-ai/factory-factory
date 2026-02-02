import { contextBridge, ipcRenderer } from 'electron';
import type { OpenDialogOptions, OpenDialogResult } from '../../src/types/electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  showOpenDialog: (options: OpenDialogOptions): Promise<OpenDialogResult> =>
    ipcRenderer.invoke('dialog:showOpen', options),
});

// Expose window focus API separately for type compatibility
contextBridge.exposeInMainWorld('electron', {
  onWindowFocusChanged: (callback: (isFocused: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isFocused: boolean) => {
      callback(isFocused);
    };
    ipcRenderer.on('window-focus-changed', handler);

    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('window-focus-changed', handler);
    };
  },
});
