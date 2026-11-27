import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

// Proving that the page recovered without a reload: a value set on `window` survives only while
// the same document stays loaded. Any reload or full navigation (the page's own, Vite's after a
// lost connection, a user's) drops it.

const MARKER = '__ffNoReloadMarker';

/** Marks the current document; pass the result to `expectNoReload` after the event. */
export async function markPage(page: Page): Promise<string> {
  const marker = randomUUID();
  await page.evaluate(([key, value]) => Reflect.set(window, key, value), [MARKER, marker] as const);
  return marker;
}

export async function expectNoReload(page: Page, marker: string) {
  expect(
    await page.evaluate((key) => Reflect.get(window, key), MARKER),
    'the page reloaded: the marker set before the event is gone'
  ).toBe(marker);
}

/**
 * Counts the WebSockets the page opens from now on, by URL path (`/snapshots`, `/chat`, …), and
 * the frames all of them have received, by path, to tell a recovery on the same socket from one
 * through a new connection. `received(path)` says a frame arrived on some socket of that path
 * since tracking began: start tracking before the page opens its first one to know that one is
 * live.
 */
export function trackSockets(page: Page) {
  const opened: string[] = [];
  const received = new Map<string, number>();
  page.on('websocket', (socket) => {
    const path = new URL(socket.url()).pathname;
    opened.push(path);
    socket.on('framereceived', () => received.set(path, (received.get(path) ?? 0) + 1));
  });
  return {
    opened: (path: string) => opened.filter((pathname) => pathname === path).length,
    received: (path: string) => received.get(path) ?? 0,
  };
}
