import { describe, expect, it } from 'vitest';
import { buildRatchetDispatchPrompt } from './ratchet-dispatch';

describe('ratchet dispatch prompt', () => {
  it('injects PR context into template', () => {
    const prompt = buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42);

    expect(prompt).toContain('https://github.com/example/repo/pull/42');
    expect(prompt).toContain('PR Number: 42');
    expect(prompt).not.toContain('{{PR_URL}}');
    expect(prompt).not.toContain('{{PR_NUMBER}}');
  });
});
