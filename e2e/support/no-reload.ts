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

/** One WebSocket the page opened: its URL path, the frames it has received, and whether it closed. */
export type TrackedSocket = { path: string; frames: number; closed: boolean };

/**
 * Tracks every WebSocket the page opens from now on, to tell a recovery on the same socket from
 * one through a new connection. Start it before the page opens the sockets you care about.
 */
export function trackSockets(page: Page) {
  const sockets: TrackedSocket[] = [];
  page.on('websocket', (socket) => {
    const tracked = { path: new URL(socket.url()).pathname, frames: 0, closed: false };
    sockets.push(tracked);
    socket.on('framereceived', () => {
      tracked.frames += 1;
    });
    socket.on('close', () => {
      tracked.closed = true;
    });
  });
  return {
    /** How many sockets the page has opened, on `path` or on any path. */
    opened: (path?: string) =>
      sockets.filter((socket) => path === undefined || socket.path === path).length,
    /** The sockets on `path` that are still open. */
    open: (path: string) => sockets.filter((socket) => socket.path === path && !socket.closed),
  };
}
