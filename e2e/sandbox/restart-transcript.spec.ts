import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { sandboxPaths } from '../../scripts/sandbox/paths.mjs';
import {
  ensureBackendRunning,
  killBackend,
  readServerLog,
  restartBackend,
} from '../support/backend-process';
import { expectNoReload, markPage, trackSockets } from '../support/no-reload';
import { launchWorkspace, openBoard, readSandbox, reply } from './sandbox';

// A crash after a finished turn: the server dies with SIGKILL and starts again on the same port.
// The open page must reconnect without a reload and show the same conversation, which the new
// server can only have read back from the fake Codex's rollout file.

test.afterEach(async () => {
  await ensureBackendRunning();
});

/** The rollout file holding `word`, and the Codex thread id in its name. */
function rolloutHolding(baseDir: string, word: string) {
  const sessions = join(sandboxPaths(baseDir).codexHome, 'sessions');
  const files = readdirSync(sessions, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(sessions, name))
    .filter((file) => readFileSync(file, 'utf8').includes(word));
  expect(files, `one rollout file mentions ${word}`).toHaveLength(1);
  const [file = ''] = files;
  const threadId = /-([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1];
  expect(threadId, `the thread id in ${file}`).toBeDefined();
  return { file, threadId };
}

test('a finished conversation survives a server crash and restart', async ({ page }) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const prompt = 'Restartfinch keeps its transcript';
  const conversation = await launchWorkspace(page, prompt, /restartfinch/);
  // Every message as the user sees it: their own and the agent's, in order.
  const transcript = () => conversation.ariaSnapshot();
  const before = await transcript();
  const rollout = rolloutHolding(sandbox.baseDir, 'Restartfinch');

  const sockets = trackSockets(page);
  const marker = await markPage(page);
  const killedAt = new Date().toISOString();
  expect(await killBackend('SIGKILL')).toMatchObject({ lastExit: { signal: 'SIGKILL' } });
  await restartBackend();

  // The restarted server rebuilt the conversation from the rollout file (the history loader), not
  // from the adapter's `session/load` replay, which reads the same file through the fake.
  await expect
    .poll(
      () =>
        readServerLog().filter(
          (record) =>
            record.timestamp > killedAt &&
            record.message === 'Hydrated provider transcript from JSONL history' &&
            record.context?.providerSessionId === rollout.threadId
        ),
      { timeout: 60_000 }
    )
    .toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ filePath: rollout.file }),
      }),
    ]);
  // The chat reconnected on a new socket and loaded the session from the new server.
  expect(sockets.opened('/chat')).toBeGreaterThan(0);
  await expect(page.getByTestId('connection-banner-reconnecting')).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect.poll(transcript, { timeout: 60_000 }).toEqual(before);

  // The conversation goes on in the resumed Codex thread, with its history shown once.
  const message = 'Restartfinch after the restart';
  await page.getByRole('textbox', { name: 'Message' }).fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(reply(conversation, message)).toBeVisible({ timeout: 120_000 });
  // Each message once, and the agent's echo of each once: a replay over the loaded history, or a
  // turn the resumed thread lost, would change a count.
  for (const text of [prompt, message]) {
    await expect(conversation.getByText(text, { exact: true })).toHaveCount(2);
  }
  await expectNoReload(page, marker);
});
