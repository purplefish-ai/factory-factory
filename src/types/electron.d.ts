export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  properties?: Array<
    | 'openFile'
    | 'openDirectory'
    | 'multiSelections'
    | 'showHiddenFiles'
    | 'createDirectory'
    | 'promptToCreate'
    | 'noResolveAliases'
    | 'treatPackageAsDirectory'
    | 'dontAddToRecent'
  >;
}

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export type DesktopCommand =
  | 'nav.settings'
  | 'nav.newWorkspace'
  | 'app.search'
  | 'app.toggleSidebar';

export interface ElectronAPI {
  isElectron: true;
  /** Subscribe to native menu commands, with cleanup on unmount. */
  onAppCommand?: (listener: (command: DesktopCommand) => void) => () => void;
  /** Restore and focus the trusted desktop window after a notification click. */
  focusWindow?: () => Promise<void>;
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogResult>;
  /**
   * Read the current OS clipboard image as base64-encoded PNG, or null when the
   * clipboard holds no image. Lets the renderer recover a usable PNG for images
   * (e.g. macOS screenshots) that the browser paste event only exposes as TIFF.
   */
  readClipboardImageAsPng: () => Promise<string | null>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
