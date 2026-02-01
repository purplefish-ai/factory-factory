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

export interface ElectronAPI {
  isElectron: true;
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogResult>;
}

export interface ElectronWindowAPI {
  onWindowFocusChanged?: (callback: (isFocused: boolean) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    electron?: ElectronWindowAPI;
  }
}
