import { expect, type Page, test } from '@playwright/test';
import { ensureBackendRunning, killBackend, restartBackend } from '../support/backend-process';
import { expectNoReload, markPage, trackSockets } from '../support/no-reload';
import { sendMessage } from './conversation';
import { launchWorkspace, openBoard, readSandbox, releaseGate } from './sandbox';

// The server crashes and stays down: the open page says it is reconnecting and keeps trying, and
// once the server is back the board and the chat work again, on the same page.

test.afterEach(async () => {
  await ensureBackendRunning();
});

/** The workspace's card in one section of the sidebar's board ("Working", "Waiting"). */
const sidebarCard = (page: Page, section: string) =>
  page
    .locator('[data-sidebar="group"]')
    .filter({
      has: page.locator('[data-sidebar="group-label"]', { hasText: new RegExp(`^${section}$`) }),
    })
    .getByRole('link', { name: /bannerwren/ });

test('the page waits out a crashed server and recovers when it restarts', async ({ page }) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const conversation = await launchWorkspace(page, 'Bannerwren waits out an outage', /bannerwren/);
  await expect(sidebarCard(page, 'Waiting')).toBeVisible({ timeout: 30_000 });

  const sockets = trackSockets(page);
  const marker = await markPage(page);
  await killBackend('SIGKILL');
  const banner = page.getByTestId('connection-banner-reconnecting');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toHaveAttribute('data-state', 'reconnecting');
  // Down for a while: the page keeps trying, and keeps saying so.
  await expect.poll(() => sockets.opened('/snapshots'), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(banner).toHaveAttribute('data-state', 'reconnecting');

  await restartBackend();
  await expect(banner).toHaveCount(0, { timeout: 60_000 });

  // The chat sends a turn and shows it streaming; the board shows the workspace at work, then
  // waiting again once the turn ends. Both arrive over the reconnected sockets.
  const gate = 'bannerwren';
  await sendMessage(page, `Bannerwren is back ff-scenario:gated-stream:${gate}`);
  await expect(conversation.getByText(`Waiting at gate ${gate}.`)).toBeVisible({ timeout: 60_000 });
  await expect(sidebarCard(page, 'Working')).toBeVisible({ timeout: 30_000 });
  releaseGate(sandbox, gate);
  await expect(conversation.getByText(`Gate ${gate} released.`)).toBeVisible({ timeout: 60_000 });
  await expect(sidebarCard(page, 'Waiting')).toBeVisible({ timeout: 30_000 });
  await expectNoReload(page, marker);
});
