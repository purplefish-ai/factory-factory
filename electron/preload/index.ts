import { contextBridge, ipcRenderer } from 'electron';
import type { OpenDialogOptions, OpenDialogResult } from '../../src/types/electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  showOpenDialog: (options: OpenDialogOptions): Promise<OpenDialogResult> =>
    ipcRenderer.invoke('dialog:showOpen', options),
});
