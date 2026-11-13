import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { expect, type Locator, test } from '@playwright/test';
import { z } from 'zod';

// One user path through the real application in the sandbox: open it, find the seeded project,
// create a workspace with the scripted Codex provider (scenario `echo`), send a message and see
// the reply. Every timeout below is sized for a machine at load 100 or more.

const sandboxSchema = z.object({
  frontendUrl: z.url(),
  repoPath: z.string().min(1),
  scenario: z.literal('echo'),
});

function readSandbox() {
  const path = z
    .string({
      message: 'FF_SANDBOX_JSON is unset: run this spec with playwright.sandbox.config.ts',
    })
    .parse(process.env.FF_SANDBOX_JSON);
  return sandboxSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The agent's reply: the echo scenario repeats the prompt, rendered as a paragraph. */
function reply(conversation: Locator, text: string) {
  return conversation
    .getByRole('paragraph')
    .filter({ hasText: new RegExp(`^${escapeRegExp(text)}$`) });
}

test('a user creates a workspace and gets the scripted agent reply', async ({ page }) => {
  const sandbox = readSandbox();
  const project = basename(sandbox.repoPath);

  // The first load compiles the client in Vite's dev server.
  await page.goto(sandbox.frontendUrl, { timeout: 120_000 });
  await expect(page).toHaveURL(new RegExp(`/projects/${escapeRegExp(project)}/workspaces$`), {
    timeout: 120_000,
  });
  await expect(
    page.getByRole('button', {
      name: new RegExp(`^Open project menu: ${escapeRegExp(project)}$`, 'i'),
    })
  ).toBeVisible({ timeout: 120_000 });

  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'New workspace' }).first().click();
  const prompt = 'Sandbox smoke launch prompt';
  await page.getByRole('textbox', { name: 'What should the agent work on?' }).fill(prompt);
  // Seeded as the default provider; the user keeps it.
  await expect(
    page.getByRole('button', { name: /^New conversation provider and model: Codex\b/ })
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Launch', exact: true }).click();

  // The board shows a placeholder card at once and, for a moment, beside the real one, which
  // appears while the server is still setting the workspace up (adding the Git worktree, starting
  // the provider). Only the real card's link leads to a workspace id rather than `optimistic-…`.
  const workspace = main
    .getByRole('link', { name: /sandbox-smoke-launch-prompt/ })
    .and(main.locator('a:not([href*="/workspaces/optimistic-"])'));
  await expect(workspace).toBeVisible({ timeout: 180_000 });
  await workspace.click();

  const conversation = page.getByRole('log', { name: 'Conversation' });
  // The launch prompt is the session's first message.
  await expect(reply(conversation, prompt)).toBeVisible({ timeout: 120_000 });

  const message = 'Second message from the sandbox smoke test';
  await page.getByRole('textbox', { name: 'Message' }).fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(reply(conversation, message)).toBeVisible({ timeout: 120_000 });
  // The user's message and the agent's echo of it: a reply that never came would leave one.
  await expect(conversation.getByText(message, { exact: true })).toHaveCount(2);
});
