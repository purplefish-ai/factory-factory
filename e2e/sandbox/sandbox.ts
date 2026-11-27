import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { sandboxPaths } from '../../scripts/sandbox/paths.mjs';

// What every spec here shares: the one sandbox the global setup started, and the controls of its
// scripted Codex provider. A prompt chooses a scenario with `ff-scenario:<name>` (see the top of
// src/backend/testing/fixtures/fake-codex-app-server.mjs); one without it gets `echo`, the
// sandbox's default, which repeats the prompt back.

const sandboxSchema = z.object({
  baseDir: z.string().min(1),
  frontendUrl: z.url(),
  repoPath: z.string().min(1),
  scenario: z.literal('echo'),
});

export function readSandbox() {
  const path = z
    .string({
      message: 'FF_SANDBOX_JSON is unset: run this spec with playwright.sandbox.config.ts',
    })
    .parse(process.env.FF_SANDBOX_JSON);
  return sandboxSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Lets a turn of `ff-scenario:gated-stream:<gate>` finish its reply: before this, the agent shows
 * the first chunk and stays at work. Creating the file before the turn reaches the gate also works.
 */
export function releaseGate(sandbox: z.infer<typeof sandboxSchema>, gate: string) {
  writeFileSync(join(sandboxPaths(sandbox.baseDir).gateDir, gate), '');
}
