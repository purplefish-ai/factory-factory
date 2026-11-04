import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopShell, type DesktopShellWindow } from './desktop-shell.js';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
);

function setup(saved?: string, packaged = true, platform: NodeJS.Platform = 'darwin') {
  const directory = mkdtempSync(join(tmpdir(), 'ff-window-'));
  directories.push(directory);
  const statePath = join(directory, 'window-state.json');
  if (saved) {
    writeFileSync(statePath, saved);
  }
  const themeListeners: Array<() => void> = [];
  const nativeTheme = {
    shouldUseDarkColors: false,
    on: (_event: 'updated', listener: () => void) => {
      themeListeners.push(listener);
    },
  };
  const menu = {
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => template),
    setApplicationMenu: vi.fn(),
  };
  const onCommand = vi.fn();
  const logger = { error: vi.fn() };
  const shell = createDesktopShell({
    statePath,
    nativeTheme,
    menu,
    isPackaged: packaged,
    platform,
    onCommand,
    logger,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  });
  return { shell, menu, nativeTheme, themeListeners, statePath, onCommand, logger };
}

function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const window: DesktopShellWindow = {
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    getNormalBounds: () => ({ x: 60, y: 70, width: 1000, height: 700 }),
    isMaximized: () => true,
    maximize: vi.fn(),
    isDestroyed: () => false,
    setBackgroundColor: vi.fn(),
  };
  return { window, emit: (event: string) => listeners.get(event)?.() };
}

function allItems(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? allItems(item.submenu) : []),
  ]);
}

describe('desktop shell', () => {
  it('offers renderer commands and native editing without development actions in production', () => {
    const { shell, menu, onCommand } = setup();
    shell.installMenu();
    const items = allItems(menu.buildFromTemplate.mock.calls[0]![0]);
    expect(items.some((item) => item.role === 'editMenu')).toBe(true);
    expect(items.some((item) => item.role === 'reload' || item.role === 'toggleDevTools')).toBe(
      false
    );
    const settings = items.find((item) => item.label === 'Settings…')!;
    expect(settings.accelerator).toBe('CmdOrCtrl+,');
    settings.click?.({} as never, {} as never, {} as never);
    expect(onCommand).toHaveBeenCalledWith('nav.settings');
    for (const [label, command] of [
      ['New Workspace', 'nav.newWorkspace'],
      ['Search', 'app.search'],
      ['Toggle Sidebar', 'app.toggleSidebar'],
    ]) {
      items.find((item) => item.label === label)!.click?.({} as never, {} as never, {} as never);
      expect(onCommand).toHaveBeenLastCalledWith(command);
    }
  });

  it('keeps debugging actions available only during development on Windows', () => {
    const { shell, menu } = setup(undefined, false, 'win32');
    shell.installMenu();
    const items = allItems(menu.buildFromTemplate.mock.calls[0]![0]);
    expect(items.some((item) => item.role === 'reload')).toBe(true);
    expect(items.some((item) => item.role === 'toggleDevTools')).toBe(true);
    expect(items.some((item) => item.role === 'services')).toBe(false);
  });

  it('starts usable with missing or corrupt state and tracks live system appearance', () => {
    const { shell, nativeTheme, themeListeners } = setup('{bad json');
    expect(shell.getWindowOptions()).toMatchObject({
      width: 1400,
      height: 900,
      minWidth: 640,
      minHeight: 480,
      backgroundColor: '#ffffff',
    });
    const { window, emit } = fakeWindow();
    shell.registerWindow(window);
    nativeTheme.shouldUseDarkColors = true;
    themeListeners.forEach((listener) => listener());
    expect(window.setBackgroundColor).toHaveBeenCalledWith('#0a0a0a');
    emit('closed');
    vi.mocked(window.setBackgroundColor).mockClear();
    themeListeners.forEach((listener) => listener());
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
  });

  it('restores and clamps bounds after a monitor is removed and restores maximization', () => {
    const { shell } = setup(
      JSON.stringify({ x: 4000, y: -2000, width: 2500, height: 1400, maximized: true })
    );
    expect(shell.getWindowOptions()).toMatchObject({ x: 0, y: 0, width: 1920, height: 1080 });
    const { window } = fakeWindow();
    shell.registerWindow(window);
    expect(window.maximize).toHaveBeenCalledOnce();
  });

  it('persists normal bounds while maximized and reopens with the same geometry', () => {
    const { shell, statePath } = setup();
    const { window, emit } = fakeWindow();
    shell.registerWindow(window);
    emit('close');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      x: 60,
      y: 70,
      width: 1000,
      height: 700,
      maximized: true,
    });
    const reopened = setup(readFileSync(statePath, 'utf8')).shell;
    expect(reopened.getWindowOptions()).toMatchObject({ x: 60, y: 70, width: 1000, height: 700 });
  });

  it('keeps an explicit app background when system appearance changes', () => {
    const { shell, nativeTheme, themeListeners } = setup();
    const { window } = fakeWindow();
    shell.registerWindow(window);
    shell.setBackgroundColor('#123456');
    nativeTheme.shouldUseDarkColors = true;
    themeListeners.forEach((listener) => listener());
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#123456');
    expect(shell.getWindowOptions().backgroundColor).toBe('#123456');
  });

  it('ignores invalid saved geometry rather than constructing an unusable window', () => {
    for (const state of [
      { x: 0, y: 0, width: -1, height: 800, maximized: false },
      { x: '0', y: 0, width: 1000, height: 800, maximized: false },
    ]) {
      expect(setup(JSON.stringify(state)).shell.getWindowOptions()).toMatchObject({
        width: 1400,
        height: 900,
      });
    }
  });
});
