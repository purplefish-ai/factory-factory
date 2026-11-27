import { expect, test } from '@playwright/test';
import { sendMessage } from './conversation';
import { launchWorkspace, openBoard, readSandbox, reply } from './sandbox';

// One user path through the real application in the sandbox: open it, find the seeded project,
// create a workspace with the scripted Codex provider (scenario `echo`), send a message and see
// the reply. Every timeout below is sized for a machine at load 100 or more.

test('a user creates a workspace and gets the scripted agent reply', async ({ page }) => {
  await openBoard(page, readSandbox());
  // The board shows a placeholder card at once and, for a moment, beside the real one, which
  // appears while the server is still setting the workspace up (adding the Git worktree, starting
  // the provider). The launch prompt is the session's first message.
  const conversation = await launchWorkspace(
    page,
    'Sandbox smoke launch prompt',
    /sandbox-smoke-launch-prompt/
  );

  const message = 'Second message from the sandbox smoke test';
  await sendMessage(page, message);
  await expect(reply(conversation, message)).toBeVisible({ timeout: 120_000 });
  // The user's message and the agent's echo of it: a reply that never came would leave one.
  await expect(conversation.getByText(message, { exact: true })).toHaveCount(2);
});
