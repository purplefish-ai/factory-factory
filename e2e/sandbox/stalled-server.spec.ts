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
  await openBoard(page, readSandbox());
  const banner = page.getByTestId('connection-banner-reconnecting');
  await expect(banner).toHaveCount(0);

  const sockets = trackSockets(page);
  const marker = await markPage(page);
  await killBackend('SIGSTOP');
  try {
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toHaveAttribute('data-state', 'unresponsive');
  } finally {
    await killBackend('SIGCONT');
  }
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  expect(sockets.opened('/snapshots'), 'a new /snapshots socket').toBe(0);
  await expectNoReload(page, marker);
});
