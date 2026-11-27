import { expect, test } from '@playwright/test';
import {
  ensureBackendRunning,
  hydrationsSince,
  killBackend,
  restartBackend,
} from '../support/backend-process';
import { expectNoReload, markPage, trackSockets } from '../support/no-reload';
import { selectedChatTab, sendMessage } from './conversation';
import { launchWorkspace, openBoard, readSandbox, reply, rolloutHolding } from './sandbox';

// A crash after a finished turn: the server dies with SIGKILL and starts again on the same port.
// The open page must reconnect without a reload and show the same conversation, which the new
// server can only have read back from the fake Codex's rollout file.

test.afterEach(async () => {
  await ensureBackendRunning();
});

test('a finished conversation survives a server crash and restart', async ({ page }) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const prompt = 'Restartfinch keeps its transcript';
  const conversation = await launchWorkspace(page, prompt, /restartfinch/);
  // Every message as the user sees it: their own and the agent's, in order.
  const transcript = () => conversation.ariaSnapshot();
  // `launchWorkspace` returns at the agent's echo, which the page can show while the workspace is
  // still starting: the conversation then also holds the startup line ("Running init script…",
  // "Creating worktree…", "Starting agent…" or "Loading session…"), and a snapshot taken then
  // differs from every later one, since the line goes away. Take it once the chat has settled:
  // the first turn finished (the tab reads Idle) and the transcript is exactly the two messages.
  await expect(selectedChatTab(page, /^Idle\b/)).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(transcript, { timeout: 60_000 })
    .toBe(['- log "Conversation":', `  - text: ${prompt}`, `  - paragraph: ${prompt}`].join('\n'));
  const before = await transcript();
  const rollout = rolloutHolding(sandbox, 'Restartfinch');

  const sockets = trackSockets(page);
  const marker = await markPage(page);
  const killedAt = new Date().toISOString();
  expect(await killBackend('SIGKILL')).toMatchObject({ lastExit: { signal: 'SIGKILL' } });
  await restartBackend();

  // The restarted server rebuilt the conversation from the rollout file (the history loader), not
  // from the adapter's `session/load` replay, which reads the same file through the fake.
  await expect
    .poll(() => hydrationsSince(rollout.threadId, killedAt), { timeout: 60_000 })
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
  await sendMessage(page, message);
  await expect(reply(conversation, message)).toBeVisible({ timeout: 120_000 });
  // Each message once, and the agent's echo of each once: a replay over the loaded history, or a
  // turn the resumed thread lost, would change a count.
  for (const text of [prompt, message]) {
    await expect(conversation.getByText(text, { exact: true })).toHaveCount(2);
  }
  await expectNoReload(page, marker);
});
