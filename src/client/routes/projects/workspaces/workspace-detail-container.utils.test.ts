import { describe, expect, it } from 'vitest';
import { hasUserMessageWithoutAgentMessage } from './workspace-detail-container.utils';

describe('workspace detail container utils', () => {
  it('returns true when the transcript has a user message and no agent message', () => {
    expect(hasUserMessageWithoutAgentMessage([{ source: 'user' }])).toBe(true);
  });

  it('returns false when the transcript has no user message', () => {
    expect(hasUserMessageWithoutAgentMessage([])).toBe(false);
  });

  it('returns false when any agent message is present', () => {
    expect(hasUserMessageWithoutAgentMessage([{ source: 'user' }, { source: 'agent' }])).toBe(
      false
    );
  });

  it('stops scanning once an agent message makes the result false', () => {
    const laterMessage = {
      get source(): 'user' | 'agent' {
        throw new Error('later messages should not be inspected');
      },
    };

    expect(hasUserMessageWithoutAgentMessage([{ source: 'agent' }, laterMessage])).toBe(false);
  });
});
