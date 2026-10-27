import { describe, expect, it } from 'vitest';
import { projectSessionStartupOptions } from './session-startup-options';

describe('shared session startup options', () => {
  it('keeps supported startup values and filters the chat-only planning flag', () => {
    expect(
      projectSessionStartupOptions({
        resumePolicy: 'require_existing',
        thinkingEnabled: false,
        planModeEnabled: true,
        model: 'chosen',
        reasoningEffort: 'high',
      })
    ).toStrictEqual({
      resumePolicy: 'require_existing',
      thinkingEnabled: false,
      model: 'chosen',
      reasoningEffort: 'high',
    });
  });
  it('preserves explicitly undefined supported keys for an empty startup request', () => {
    expect(projectSessionStartupOptions({})).toStrictEqual({
      resumePolicy: undefined,
      thinkingEnabled: undefined,
      model: undefined,
      reasoningEffort: undefined,
    });
  });
});
