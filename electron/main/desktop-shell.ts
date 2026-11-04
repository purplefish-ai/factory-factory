import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type {
  BrowserWindowConstructorOptions,
  MenuItemConstructorOptions,
  Rectangle,
} from 'electron';
import { z } from 'zod';
import type { DesktopCommand } from '../../src/types/electron.js';

const windowStateSchema = z.object({
  x: z.number().int().min(-100_000).max(100_000),
  y: z.number().int().min(-100_000).max(100_000),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
  maximized: z.boolean(),
});
type WindowState = z.infer<typeof windowStateSchema>;

export interface DesktopShellWindow {
  on(event: 'close' | 'closed', listener: () => void): void;
  getNormalBounds(): Rectangle;
  isMaximized(): boolean;
  maximize(): void;
  isDestroyed(): boolean;
  setBackgroundColor(color: string): void;
}

export interface DesktopShell {
  installMenu(): void;
  setBackgroundColor(color: string): void;
  getWindowOptions(): BrowserWindowConstructorOptions;
  registerWindow(window: DesktopShellWindow): void;
}

export function createDesktopShell<MenuType>({
  statePath,
  nativeTheme,
  menu,
  isPackaged,
  platform,
  onCommand,
  logger,
  screen,
}: {
  statePath: string;
  nativeTheme: { shouldUseDarkColors: boolean; on(event: 'updated', listener: () => void): void };
  menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]): MenuType;
    setApplicationMenu(menu: MenuType): void;
  };
  isPackaged: boolean;
  platform: NodeJS.Platform;
  onCommand: (command: DesktopCommand) => void;
  logger: { error(...args: unknown[]): void };
  screen: { getDisplayMatching(bounds: Rectangle): { workArea: Rectangle } };
}): DesktopShell {
  let state: WindowState | undefined;
  try {
    state = windowStateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    // Window preferences are optional; missing/corrupt files cannot block startup.
  }
  const windows = new Set<DesktopShellWindow>();
  let rendererBackground: string | undefined;
  const backgroundColor = () =>
    rendererBackground ?? (nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff');
  nativeTheme.on('updated', () => {
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.setBackgroundColor(backgroundColor());
      }
    }
  });

  const action = (
    label: string,
    accelerator: string,
    command: DesktopCommand
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => onCommand(command),
  });
  const settings = action('Settings…', 'CmdOrCtrl+,', 'nav.settings');
  const newWorkspace = action('New workspace', 'CmdOrCtrl+N', 'nav.newWorkspace');

  return {
    setBackgroundColor(color) {
      rendererBackground = color;
      for (const window of windows) {
        if (!window.isDestroyed()) {
          window.setBackgroundColor(color);
        }
      }
    },
    installMenu() {
      const application: MenuItemConstructorOptions =
        platform === 'darwin'
          ? {
              label: 'Factory Factory',
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                settings,
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            }
          : {
              label: 'File',
              submenu: [
                newWorkspace,
                settings,
                { type: 'separator' },
                { role: 'close' },
                { role: 'quit' },
              ],
            };
      const template: MenuItemConstructorOptions[] = [
        application,
        ...(platform === 'darwin'
          ? [{ label: 'File', submenu: [newWorkspace, { role: 'close' as const }] }]
          : []),
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            action('Search', 'CmdOrCtrl+K', 'app.search'),
            action('Toggle sidebar', 'CmdOrCtrl+B', 'app.toggleSidebar'),
            { type: 'separator' },
            { role: 'togglefullscreen' },
            ...(!isPackaged
              ? [
                  { type: 'separator' as const },
                  { role: 'reload' as const },
                  { role: 'forceReload' as const },
                  { role: 'toggleDevTools' as const },
                ]
              : []),
          ],
        },
        { role: 'windowMenu' },
      ];
      menu.setApplicationMenu(menu.buildFromTemplate(template));
    },
    getWindowOptions() {
      const bounds = state ?? { x: 0, y: 0, width: 1400, height: 900 };
      const { workArea } = screen.getDisplayMatching(bounds);
      const width = Math.min(Math.max(640, bounds.width), workArea.width);
      const height = Math.min(Math.max(480, bounds.height), workArea.height);
      return {
        width,
        height,
        minWidth: Math.min(640, workArea.width),
        minHeight: Math.min(480, workArea.height),
        backgroundColor: backgroundColor(),
        ...(state
          ? {
              x: Math.min(Math.max(state.x, workArea.x), workArea.x + workArea.width - width),
              y: Math.min(Math.max(state.y, workArea.y), workArea.y + workArea.height - height),
            }
          : {}),
      };
    },
    registerWindow(window) {
      windows.add(window);
      if (state?.maximized) {
        window.maximize();
      }
      window.on('close', () => {
        try {
          state = windowStateSchema.parse({
            ...window.getNormalBounds(),
            maximized: window.isMaximized(),
          });
          writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
          renameSync(`${statePath}.tmp`, statePath);
        } catch (error) {
          logger.error('[electron] Could not save window preferences:', error);
        }
      });
      window.on('closed', () => {
        windows.delete(window);
      });
    },
  };
}
