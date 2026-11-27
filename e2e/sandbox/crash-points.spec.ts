import { expect, test } from '@playwright/test';
import {
  armCrashPoint,
  backendStatus,
  ensureBackendRunning,
  isCrashPointArmed,
  hydrationsSince,
  readServerOutput,
  restartBackend,
  waitForBackendExit,
} from '../support/backend-process';
import { expectNoReload, markPage, trackSockets } from '../support/no-reload';
import { launchWorkspace, openBoard, readSandbox, reply, rolloutHolding } from './sandbox';

// Crash points end the server where server code declares them (src/backend/services/
// crash-point.ts), as a crash there would. One that no code declares cannot be armed.

test.afterEach(async () => {
  await ensureBackendRunning();
});

test('arming a crash point that no code declares fails', async () => {
  expect(() => armCrashPoint('no-such-crash-point')).toThrow(
    /No code declares crash point "no-such-crash-point"; declared: .*after-message-queued/
  );
  expect(isCrashPointArmed('no-such-crash-point')).toBe(false);
  expect(await backendStatus()).toMatchObject({ state: 'running' });
});

/**
 * Resolves once the chat has reloaded the session from the restarted server: a /chat socket opened
 * after the first `before` is still open and has received frames. Until then the page shows what it
 * held before the crash, so its transcript proves nothing.
 */
async function expectChatReloaded(sockets: ReturnType<typeof trackSockets>, before: number) {
  await expect
    .poll(
      () =>
        sockets.openedAfter('/chat', before).some((socket) => !socket.closed && socket.frames > 0),
      { timeout: 60_000 }
    )
    .toBe(true);
}

test('an armed crash point ends the server once, where it is declared', async ({ page }) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const prompt = 'Crashlark queues a message';
  const sockets = trackSockets(page);
  const conversation = await launchWorkspace(page, prompt, /crashlark/);
  const marker = await markPage(page);
  const chatsBefore = sockets.opened('/chat');

  armCrashPoint('after-message-queued');
  const message = 'Crashlark message accepted before the crash';
  await page.getByRole('textbox', { name: 'Message' }).fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  expect(await waitForBackendExit()).toEqual({ code: null, signal: 'SIGKILL' });
  expect(readServerOutput()).toContain('crash point after-message-queued reached');
  expect(isCrashPointArmed('after-message-queued')).toBe(false);
  await expect(page.getByTestId('connection-banner-reconnecting')).toBeVisible({
    timeout: 10_000,
  });

  // Restarted unarmed: the server stays up and the page recovers.
  await restartBackend();
  await expect(page.getByTestId('connection-banner-reconnecting')).toHaveCount(0, {
    timeout: 60_000,
  });
  await expectChatReloaded(sockets, chatsBefore);
  await expect(reply(conversation, prompt)).toBeVisible({ timeout: 60_000 });
  expect(await backendStatus()).toMatchObject({ state: 'running' });
  await expectNoReload(page, marker);
});

test('a message accepted before a crash is delivered after the restart', async ({ page }) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const sockets = trackSockets(page);
  const conversation = await launchWorkspace(page, 'Crashwren keeps its queue', /crashwren/);
  const rollout = rolloutHolding(sandbox, 'Crashwren');
  const marker = await markPage(page);
  const chatsBefore = sockets.opened('/chat');

  armCrashPoint('after-message-queued');
  const message = 'Crashwren message accepted before the crash';
  await page.getByRole('textbox', { name: 'Message' }).fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  expect(await waitForBackendExit()).toEqual({ code: null, signal: 'SIGKILL' });
  // The page shows it queued, with a button to cancel it.
  await expect(conversation.getByRole('button', { name: 'Cancel queued message' })).toBeVisible();
  await expect(conversation.getByText(message, { exact: true })).toBeVisible();

  const crashedAt = new Date().toISOString();
  await restartBackend();
  await expect(page.getByTestId('connection-banner-reconnecting')).toHaveCount(0, {
    timeout: 60_000,
  });
  // The restarted server has loaded this session, and the page has it over a new chat socket.
  await expect
    .poll(() => hydrationsSince(rollout.threadId, crashedAt).length, { timeout: 60_000 })
    .toBe(1);
  await expectChatReloaded(sockets, chatsBefore);
  await expect(reply(conversation, 'Crashwren keeps its queue')).toBeVisible();
  await expectNoReload(page, marker);

  // Known bug: an accepted prompt is lost when the server crashes before dispatch; plan task 3.4
  // (durable prompts, docs/superpowers/plans/2026-11-27-architecture-consolidation.md) makes this
  // pass, and this marker is then removed. Everything above must pass; only the line below fails.
  // Its short wait is enough today; a durable queue may need longer to dispatch the message.
  test.fail();
  await expect(reply(conversation, message)).toBeVisible({ timeout: 5000 });
});
