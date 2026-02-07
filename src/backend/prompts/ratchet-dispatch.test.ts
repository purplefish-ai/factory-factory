import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRatchetDispatchPrompt, clearRatchetDispatchPromptCache } from './ratchet-dispatch';

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

describe('ratchet dispatch prompt', () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearRatchetDispatchPromptCache();
  });

  it('injects PR context into template', () => {
    readFileSyncMock.mockReturnValue('PR Number: {{PR_NUMBER}}\nPR URL: {{PR_URL}}');
    clearRatchetDispatchPromptCache();
    const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42);

    expect(prompt).toContain('https://github.com/example/repo/pull/42');
    expect(prompt).toContain('PR Number: 42');
    expect(prompt).not.toContain('{{PR_URL}}');
    expect(prompt).not.toContain('{{PR_NUMBER}}');
  });

  it('falls back to built-in template when file is empty', () => {
    readFileSyncMock.mockReturnValue('');
    clearRatchetDispatchPromptCache();
    const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42);

    expect(prompt).toContain('Execute autonomously in this order:');
    expect(prompt).toContain('https://github.com/example/repo/pull/42');
  });
});
