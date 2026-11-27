import { expect, test } from '@playwright/test';
import { ensureBackendRunning, killBackend } from '../support/backend-process';
import { expectNoReload, markPage, trackSockets } from '../support/no-reload';
import { openBoard, readSandbox } from './sandbox';

// The server stalls with its sockets open (SIGSTOP), so nothing closes and nothing answers: the
// page notices the silence, says the server is not responding, and recovers on the same sockets
// when the server continues before the page gives the socket up (30 s).

test.afterEach(async () => {
  await ensureBackendRunning();
});

test('the page notices a silent server and recovers on the same sockets', async ({ page }) => {
  const sockets = trackSockets(page);
  await openBoard(page, readSandbox());
  const banner = page.getByTestId('connection-banner-reconnecting');
  await expect(banner).toHaveCount(0);
  // The board's one /snapshots socket is open and live now: a frame (the reply to the page's
  // ping, every 4 s) arrives on it after this point, so the page is watching it for silence.
  await expect.poll(() => sockets.open('/snapshots').length, { timeout: 60_000 }).toBe(1);
  const [board] = sockets.open('/snapshots');
  const framesBefore = board?.frames ?? 0;
  await expect.poll(() => board?.frames ?? 0, { timeout: 15_000 }).toBeGreaterThan(framesBefore);
  const openedBefore = sockets.opened();

  const marker = await markPage(page);
  await killBackend('SIGSTOP');
  try {
    // The page pings every 4 s and calls a ping unanswered after 4 s more (websocket-liveness.ts):
    // the banner shows 8 s after the stall at the latest on an idle machine, later when the page's
    // timers are delayed. The page gives the socket up 30 s after the ping, and this wait must end
    // before that, since the banner then turns to "reconnecting" and the socket is lost.
    await expect(banner).toBeVisible({ timeout: 25_000 });
    await expect(banner).toHaveAttribute('data-state', 'unresponsive');
  } finally {
    await killBackend('SIGCONT');
  }
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  // The same socket carried the page through, and the page opened no other.
  expect(board?.closed, 'the /snapshots socket closed').toBe(false);
  expect(sockets.opened(), 'sockets opened during the stall').toBe(openedBefore);
  await expectNoReload(page, marker);
});
