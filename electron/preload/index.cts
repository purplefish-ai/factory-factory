import { contextBridge, ipcRenderer } from 'electron';
import type { OpenDialogOptions, OpenDialogResult } from '../../src/types/electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  focusWindow: (): Promise<void> => ipcRenderer.invoke('window:focus'),
  showOpenDialog: (options: OpenDialogOptions): Promise<OpenDialogResult> =>
    ipcRenderer.invoke('dialog:showOpen', options),
  readClipboardImageAsPng: (): Promise<string | null> =>
    ipcRenderer.invoke('clipboard:readImagePng'),
});
