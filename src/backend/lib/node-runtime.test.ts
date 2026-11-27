import { describe, expect, it } from 'vitest';
import { getBundledClaudeCommand } from './claude-cli-command';
import { getBundledCodexCommand } from './codex-cli-command';

describe('configured Node exec path', () => {
  it('uses the current runtime', () => {
    expect(getBundledClaudeCommand(['--version']).command).toBe(process.execPath);
    expect(getBundledCodexCommand(['--version']).command).toBe(process.execPath);
  });
});
