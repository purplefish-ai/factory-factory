import { expect, test } from '@playwright/test';
import {
  armCrashPoint,
  backendStatus,
  ensureBackendRunning,
  isCrashPointArmed,
  readServerOutput,
  restartBackend,
  waitForBackendExit,
} from '../support/backend-process';
import { expectNoReload, markPage } from '../support/no-reload';
import { launchWorkspace, openBoard, readSandbox, reply } from './sandbox';

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

test('an armed crash point ends the server once, where it is declared', async ({ page }) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const prompt = 'Crashlark queues a message';
  const conversation = await launchWorkspace(page, prompt, /crashlark/);
  const marker = await markPage(page);

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
  await expect(reply(conversation, prompt)).toBeVisible({ timeout: 60_000 });
  expect(await backendStatus()).toMatchObject({ state: 'running' });
  await expectNoReload(page, marker);
});

// Known bug, kept failing on purpose: the queue lives only in the server's memory, so a message
// the server accepted, and the page shows as queued, is gone after a crash: after the restart the
// conversation holds neither the message nor a reply. Task 3.4 of
// docs/superpowers/plans/2026-11-27-architecture-consolidation.md makes accepted prompts durable;
// remove `test.fail` then.
test.fail('a message accepted before a crash is delivered after the restart', async ({ page }) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const conversation = await launchWorkspace(page, 'Crashwren keeps its queue', /crashwren/);

  armCrashPoint('after-message-queued');
  const message = 'Crashwren message accepted before the crash';
  await page.getByRole('textbox', { name: 'Message' }).fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  expect(await waitForBackendExit()).toEqual({ code: null, signal: 'SIGKILL' });
  // The page shows it queued, with a button to cancel it.
  await expect(conversation.getByRole('button', { name: 'Cancel queued message' })).toBeVisible();
  await expect(conversation.getByText(message, { exact: true })).toBeVisible();

  await restartBackend();
  await expect(page.getByTestId('connection-banner-reconnecting')).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(reply(conversation, message)).toBeVisible({ timeout: 15_000 });
});
