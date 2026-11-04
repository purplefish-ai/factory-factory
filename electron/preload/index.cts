import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopCommand, OpenDialogOptions, OpenDialogResult } from '../../src/types/electron';

const desktopCommands: Record<DesktopCommand, true> = {
  'nav.settings': true,
  'nav.newWorkspace': true,
  'app.search': true,
  'app.toggleSidebar': true,
};
function isDesktopCommand(value: unknown): value is DesktopCommand {
  return typeof value === 'string' && Object.hasOwn(desktopCommands, value);
}

let appCommandSubscriptions = 0;

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  onAppCommand: (listener: (command: DesktopCommand) => void): (() => void) => {
    const handler = (_event: unknown, command: unknown) => {
      if (isDesktopCommand(command)) {
        listener(command);
      }
    };
    ipcRenderer.on('app:command', handler);
    appCommandSubscriptions++;
    void ipcRenderer.invoke('app:commands-ready', true).catch(() => undefined);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      ipcRenderer.removeListener('app:command', handler);
      appCommandSubscriptions--;
      if (appCommandSubscriptions === 0) {
        void ipcRenderer.invoke('app:commands-ready', false).catch(() => undefined);
      }
    };
  },
  setBackgroundColor: (color: string): Promise<void> =>
    ipcRenderer.invoke('window:background-color', color),
  focusWindow: (): Promise<void> => ipcRenderer.invoke('window:focus'),
  showOpenDialog: (options: OpenDialogOptions): Promise<OpenDialogResult> =>
    ipcRenderer.invoke('dialog:showOpen', options),
  readClipboardImageAsPng: (): Promise<string | null> =>
    ipcRenderer.invoke('clipboard:readImagePng'),
});
