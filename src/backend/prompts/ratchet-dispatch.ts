import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../services/logger.service';

const logger = createLogger('ratchet-prompt');

const DISPATCH_PROMPT_PATH = resolve(
  import.meta.dirname,
  '../../..',
  'prompts/ratchet/dispatch.md'
);

const FALLBACK_TEMPLATE = `You are the autonomous Ratchet agent for this workspace.

Context:
- PR Number: {{PR_NUMBER}}
- PR URL: {{PR_URL}}

Execute autonomously in this order:
1. Merge latest main and resolve conflicts.
2. Check CI failures and fix them.
3. Address unaddressed code review comments.
4. Run build/lint/test and fix failures.
5. Push your changes.
6. Comment briefly on addressed review comments and resolve them.

Do not ask for confirmation.`;

let cachedTemplate: string | null = null;

function getTemplate(): string {
  if (cachedTemplate !== null) {
    return cachedTemplate;
  }

  try {
    cachedTemplate = readFileSync(DISPATCH_PROMPT_PATH, 'utf-8').trim();
    return cachedTemplate;
  } catch (error) {
    logger.error('Failed to load ratchet dispatch prompt template; using fallback', {
      path: DISPATCH_PROMPT_PATH,
      error: String(error),
    });
    cachedTemplate = FALLBACK_TEMPLATE;
    return cachedTemplate;
  }
}

export function buildRatchetDispatchPrompt(prUrl: string, prNumber: number): string {
  return getTemplate()
    .replaceAll('{{PR_URL}}', prUrl)
    .replaceAll('{{PR_NUMBER}}', String(prNumber));
}

export function clearRatchetDispatchPromptCache(): void {
  cachedTemplate = null;
}
