import { describe, expect, it } from 'vitest';
import { readWorkspaceInitialPrompt } from './workspace-initial-prompt';

describe('readWorkspaceInitialPrompt', () => {
  it('reads a string initial prompt and ignores the rest of the metadata', () => {
    expect(
      readWorkspaceInitialPrompt({ initialPrompt: 'Fix it', initialAttachments: [{ data: 'x' }] })
    ).toBe('Fix it');
    expect(readWorkspaceInitialPrompt({ initialPrompt: '' })).toBe('');
  });

  it('returns null for missing or malformed metadata', () => {
    expect(readWorkspaceInitialPrompt(null)).toBeNull();
    expect(readWorkspaceInitialPrompt({})).toBeNull();
    expect(readWorkspaceInitialPrompt({ initialPrompt: 7 })).toBeNull();
    expect(readWorkspaceInitialPrompt('prompt')).toBeNull();
  });
});
