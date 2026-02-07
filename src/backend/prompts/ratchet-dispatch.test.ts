import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRatchetDispatchPrompt, clearRatchetDispatchPromptCache } from './ratchet-dispatch';

describe('ratchet dispatch prompt', () => {
  const templatePath = resolve(import.meta.dirname, '../../..', 'prompts/ratchet/dispatch.md');

  afterEach(() => {
    vi.restoreAllMocks();
    clearRatchetDispatchPromptCache();
  });

  it('injects PR context into template', () => {
    const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42);

    expect(prompt).toContain('https://github.com/example/repo/pull/42');
    expect(prompt).toContain('PR Number: 42');
    expect(prompt).not.toContain('{{PR_URL}}');
    expect(prompt).not.toContain('{{PR_NUMBER}}');
  });

  it('falls back to built-in template when file is empty', () => {
    const originalTemplate = readFileSync(templatePath, 'utf-8');
    writeFileSync(templatePath, '');
    clearRatchetDispatchPromptCache();
    try {
      const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42);
      expect(prompt).toContain('Execute autonomously in this order:');
      expect(prompt).toContain('https://github.com/example/repo/pull/42');
    } finally {
      writeFileSync(templatePath, originalTemplate);
    }
  });
});
