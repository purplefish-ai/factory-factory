// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFakeWebSocket,
  lastSocket,
  setDocumentVisibility,
} from '@/hooks/fake-websocket.test-helpers';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import {
  ConnectionHealthContext,
  ConnectionHealthStore,
} from '@/hooks/websocket-connection-health';
import { ConnectionBanner } from './connection-banner';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

function Snapshots() {
  useWebSocketTransport({ url: '/snapshots?projectId=p1', announceConnectionLoss: true });
  return null;
}

// Roots still mounted, so a failed assertion cannot leak a live transport.
const mounted = new Set<ReturnType<typeof createRoot>>();

async function renderApp(clientVersion: string, onReload: () => void) {
  const store = new ConnectionHealthStore();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.add(root);
  const tree: ReactNode = createElement(
    ConnectionHealthContext.Provider,
    { value: store },
    createElement(ConnectionBanner, { clientVersion, onReload }),
    createElement(Snapshots)
  );
  await act(async () => {
    root.render(tree);
    await Promise.resolve();
  });
  return {
    container,
    unmount: () =>
      act(() => {
        mounted.delete(root);
        root.unmount();
      }),
  };
}

function reloadButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Reload to update'
  );
}

describe('ConnectionBanner', () => {
  beforeEach(() => {
    installFakeWebSocket();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    setDocumentVisibility('visible');
  });

  afterEach(() => {
    for (const root of mounted) {
      act(() => root.unmount());
    }
    mounted.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('shows Reconnecting… while the snapshot socket retries, and clears when it is back', async () => {
    const app = await renderApp('1.0.0', vi.fn());
    await act(() => {
      lastSocket().open();
      lastSocket().receive({ ffTransport: 'hello', version: '1.0.0' });
    });
    expect(app.container.textContent).toBe('');

    await act(async () => lastSocket().drop());
    const banner = app.container.querySelector('[data-testid="connection-banner-reconnecting"]');
    expect(banner?.textContent).toBe('Connection lost. Reconnecting…');
    expect(banner?.getAttribute('data-state')).toBe('reconnecting');
    expect(banner?.getAttribute('role')).toBe('status');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      lastSocket().open();
    });
    expect(app.container.textContent).toBe('');
    await app.unmount();
  });

  it('says the server is not responding while its socket is open but silent', async () => {
    const app = await renderApp('1.0.0', vi.fn());
    await act(() => {
      lastSocket().open();
      lastSocket().receive({ ffTransport: 'hello', version: '1.0.0' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    const banner = app.container.querySelector('[data-testid="connection-banner-reconnecting"]');
    expect(banner?.textContent).toBe("Factory Factory isn't responding. Waiting for a reply…");
    expect(banner?.getAttribute('data-state')).toBe('unresponsive');
    expect(banner?.getAttribute('role')).toBe('status');

    // The late reply clears it on the same socket.
    await act(() => lastSocket().answerPing());
    expect(app.container.textContent).toBe('');
    await app.unmount();
  });

  it('asks a tab older than the server to reload, and never reloads by itself', async () => {
    const onReload = vi.fn();
    const app = await renderApp('1.0.0', onReload);
    await act(() => {
      lastSocket().open();
      lastSocket().receive({ ffTransport: 'hello', version: '1.1.0' });
    });

    const button = reloadButton(app.container);
    expect(button).toBeDefined();
    expect(app.container.textContent).toContain('Factory Factory has been updated.');
    // The user may be typing: nothing reloads until they ask, however long
    // the tab stays open on a live connection.
    await act(async () => {
      for (let ping = 0; ping < 150; ping += 1) {
        await vi.advanceTimersByTimeAsync(4000);
        lastSocket().answerPing();
      }
    });
    expect(onReload).not.toHaveBeenCalled();
    expect(reloadButton(app.container)).toBeDefined();

    await act(async () => button?.click());
    expect(onReload).toHaveBeenCalledOnce();
    await app.unmount();
  });

  it('shows nothing when the versions match or an older server sends none', async () => {
    const matching = await renderApp('1.0.0', vi.fn());
    await act(() => {
      lastSocket().open();
      lastSocket().receive({ ffTransport: 'hello', version: '1.0.0' });
    });
    expect(matching.container.textContent).toBe('');
    await matching.unmount();

    const older = await renderApp('1.0.0', vi.fn());
    await act(async () => lastSocket().open());
    expect(older.container.textContent).toBe('');
    await older.unmount();
  });
});
