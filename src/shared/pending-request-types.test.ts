import { describe, expect, it } from 'vitest';
import { hasAskUserQuestionInput, isUserQuestionRequest } from './pending-request-types';

describe('pending-request-types helpers', () => {
  it('detects AskUserQuestion-style input shape', () => {
    expect(hasAskUserQuestionInput({ questions: [] })).toBe(true);
    expect(hasAskUserQuestionInput({})).toBe(false);
    expect(hasAskUserQuestionInput(null)).toBe(false);
  });

  it('treats AskUserQuestion tool names as user-question requests', () => {
    expect(
      isUserQuestionRequest({
        toolName: 'AskUserQuestion',
        input: {},
      })
    ).toBe(true);
  });

  it('treats request payloads with questions as user-question requests', () => {
    expect(
      isUserQuestionRequest({
        toolName: 'Tool input request',
        input: { questions: [{ question: 'Q1' }] },
      })
    ).toBe(true);
  });
});
