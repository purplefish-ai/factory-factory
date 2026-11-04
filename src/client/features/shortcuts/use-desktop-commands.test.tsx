// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { registerShortcutHandler } from '@/client/lib/shortcut-registry';
import type { DesktopCommand } from '@/types/electron';
import { useDesktopCommands } from './use-desktop-commands';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function Harness() {
  useDesktopCommands();
  return null;
}
it('routes native commands through active handlers and removes its subscription on unmount', async () => {
  let receive: ((command: DesktopCommand) => void) | undefined;
  const cleanup = vi.fn();
  const search = vi.fn();
  const unregister = registerShortcutHandler('app.search', search);
  const original = window.electronAPI;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      onAppCommand: (listener: (command: DesktopCommand) => void) => {
        receive = listener;
        return cleanup;
      },
    },
  });
  const root = createRoot(document.createElement('div'));
  try {
    await act(() => root.render(<Harness />));
    receive?.('app.search');
    expect(search).toHaveBeenCalledTimes(1);
    await act(() => root.unmount());
    expect(cleanup).toHaveBeenCalledTimes(1);
  } finally {
    unregister();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: original });
  }
});
