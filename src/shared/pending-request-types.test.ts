import { describe, expect, it } from 'vitest';
import {
  hasAskUserQuestionInput,
  hasExitPlanModeInput,
  isExitPlanModeRequest,
  isUserQuestionRequest,
} from './pending-request-types';

describe('pending-request-types helpers', () => {
  it('detects AskUserQuestion-style input shape', () => {
    expect(hasAskUserQuestionInput({ questions: [] })).toBe(false);
    expect(hasAskUserQuestionInput({})).toBe(false);
    expect(hasAskUserQuestionInput(null)).toBe(false);
  });

  it('treats AskUserQuestion tool names as user-question requests', () => {
    expect(
      isUserQuestionRequest({
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'What next?', options: [] }] },
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

  it.each(
    [
      [],
      ['survey'],
      [{ prompt: 'Q' }],
      [{ question: '' }],
      [{ question: 'Q', options: [{ value: 'A' }] }],
      [{ question: 'Q' }, null],
    ].map((questions) => [questions])
  )(
    'rejects empty or malformed question input %j even with an explicit question alias',
    (questions) => {
      expect(hasAskUserQuestionInput({ questions })).toBe(false);
      expect(isUserQuestionRequest({ toolName: 'AskUserQuestion', input: { questions } })).toBe(
        false
      );
    }
  );

  it.each([undefined, null, []].map((options) => [options]))(
    'retains free-form question inputs with options %j',
    (options) => {
      expect(hasAskUserQuestionInput({ questions: [{ question: 'What next?', options }] })).toBe(
        true
      );
    }
  );

  it('never treats a named MCP tool as a question prompt even with a matching display name and shape', () => {
    expect(
      isUserQuestionRequest({
        toolName: 'AskUserQuestion',
        rawToolName: 'mcp__survey__poll',
        input: { questions: [{ question: 'Q', options: [{ label: 'A' }] }] },
      })
    ).toBe(false);
    expect(
      isUserQuestionRequest({
        toolName: 'mcp__survey__poll',
        input: { questions: [{ question: 'Q' }] },
      })
    ).toBe(false);
  });

  it('detects ExitPlanMode by stable input type', () => {
    expect(hasExitPlanModeInput({ type: 'ExitPlanMode' })).toBe(true);
    expect(hasExitPlanModeInput({ type: 'Review Proposed Plan' })).toBe(false);
    expect(
      isExitPlanModeRequest({
        toolName: 'Review Proposed Plan',
        input: { type: 'ExitPlanMode' },
      })
    ).toBe(true);
  });
});
