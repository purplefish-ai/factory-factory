import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { sandboxPaths } from '../../scripts/sandbox/paths.mjs';

// What every spec here shares: the one sandbox the global setup started, and the controls of its
// scripted Codex provider. A prompt chooses a scenario with `ff-scenario:<name>` (see the top of
// src/backend/testing/fixtures/fake-codex-app-server.mjs); one without it gets `echo`, the
// sandbox's default, which repeats the prompt back.

const sandboxSchema = z.object({
  baseDir: z.string().min(1),
  backendUrl: z.url(),
  frontendUrl: z.url(),
  repoPath: z.string().min(1),
  scenario: z.literal('echo'),
});

export type Sandbox = z.infer<typeof sandboxSchema>;

export function readSandbox(): Sandbox {
  const path = z
    .string({
      message: 'FF_SANDBOX_JSON is unset: run this spec with playwright.sandbox.config.ts',
    })
    .parse(process.env.FF_SANDBOX_JSON);
  return sandboxSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What the fake reads as a gate (or scenario argument) name: anything else ends the name early. */
const GATE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Lets a turn of `ff-scenario:gated-stream:<gate>` finish its reply: before this, the agent shows
 * the first chunk and stays at work. Creating the file before the turn reaches the gate also works.
 * The fake deletes the file when it passes the gate; a file still there means another turn has not
 * reached its gate yet, so releasing the same name again fails instead of releasing that turn.
 */
export function releaseGate(sandbox: Sandbox, gate: string) {
  if (!GATE_NAME.test(gate)) {
    throw new Error(`Gate name ${JSON.stringify(gate)} must match ${GATE_NAME}.`);
  }
  writeFileSync(join(sandboxPaths(sandbox.baseDir).gateDir, gate), '', { flag: 'wx' });
}

/** The agent's reply: the echo scenario repeats the prompt, rendered as a paragraph. */
export function reply(conversation: Locator, text: string) {
  return conversation
    .getByRole('paragraph')
    .filter({ hasText: new RegExp(`^${escapeRegExp(text)}$`) });
}

/**
 * Fails at once when the shared backend does not answer, which happens only when an earlier spec
 * could not restore it (its `afterEach` error says why), instead of on a later two-minute wait.
 */
export async function expectBackendAnswering(sandbox: Sandbox) {
  let problem: string;
  try {
    const response = await fetch(`${sandbox.backendUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      return;
    }
    problem = `status ${response.status}`;
  } catch (error) {
    problem = String(error);
  }
  throw new Error(
    `The sandbox backend does not answer /health (${problem}): an earlier spec left it down or stopped.`
  );
}

/**
 * Opens the seeded project's board, once the backend answers. The first load compiles the client
 * in Vite's dev server.
 */
export async function openBoard(page: Page, sandbox: Sandbox) {
  await expectBackendAnswering(sandbox);
  const project = basename(sandbox.repoPath);
  await page.goto(sandbox.frontendUrl, { timeout: 120_000 });
  await expect(page).toHaveURL(new RegExp(`/projects/${escapeRegExp(project)}/workspaces$`), {
    timeout: 120_000,
  });
  await expect(
    page.getByRole('button', {
      name: new RegExp(`^Open project menu: ${escapeRegExp(project)}$`, 'i'),
    })
  ).toBeVisible({ timeout: 120_000 });
}

/**
 * Launches a Codex workspace from the board with `prompt`, opens it and waits for the agent's echo
 * of the prompt. `cardName` matches the workspace's name, made from the prompt's first words: begin
 * the prompt with a word no other spec uses, before any scenario token.
 */
export async function launchWorkspace(page: Page, prompt: string, cardName: RegExp) {
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'New workspace' }).first().click();
  await page.getByRole('textbox', { name: 'What should the agent work on?' }).fill(prompt);
  await expect(
    page.getByRole('button', { name: /^New conversation provider and model: Codex\b/ })
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  // Only the real card's link leads to a workspace id rather than `optimistic-…`.
  const workspace = main
    .getByRole('link', { name: cardName })
    .and(main.locator('a:not([href*="/workspaces/optimistic-"])'));
  await expect(workspace).toBeVisible({ timeout: 180_000 });
  await workspace.click();
  const conversation = page.getByRole('log', { name: 'Conversation' });
  await expect(reply(conversation, prompt)).toBeVisible({ timeout: 120_000 });
  return conversation;
}

/** The fake Codex's rollout file that mentions `word`, and the Codex thread id in its name. */
export function rolloutHolding(sandbox: Sandbox, word: string) {
  const sessions = join(sandboxPaths(sandbox.baseDir).codexHome, 'sessions');
  const files = readdirSync(sessions, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(sessions, name))
    .filter((file) => readFileSync(file, 'utf8').includes(word));
  expect(files, `one rollout file mentions ${word}`).toHaveLength(1);
  const [file = ''] = files;
  const threadId = /-([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1] ?? '';
  expect(threadId, `the thread id in ${file}`).not.toBe('');
  return { file, threadId };
}
