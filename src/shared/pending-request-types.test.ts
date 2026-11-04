import { describe, expect, it } from 'vitest';
import {
  getPendingRequestType,
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

  it('treats AskUserQuestion requests with usable questions as user-question requests', () => {
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

describe('getPendingRequestType', () => {
  it('classifies plan approval by tool name or input type', () => {
    expect(getPendingRequestType({ toolName: 'ExitPlanMode' })).toBe('plan_approval');
    expect(
      getPendingRequestType({ toolName: 'Ready to code?', input: { type: 'ExitPlanMode' } })
    ).toBe('plan_approval');
  });

  it('classifies non-MCP requests with usable questions as user questions', () => {
    expect(
      getPendingRequestType({
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'What next?', options: [] }] },
      })
    ).toBe('user_question');
  });

  it.each([
    { toolName: 'ExitPlanMode', rawToolName: 'mcp__server__plan' },
    { toolName: 'mcp__server__plan' },
  ])('keeps MCP identity ahead of plan-shaped input: %j', (identity) => {
    expect(getPendingRequestType({ ...identity, input: { type: 'ExitPlanMode' } })).toBe(
      'permission_request'
    );
  });

  it('classifies MCP and other tool requests as permission requests', () => {
    expect(
      getPendingRequestType({
        toolName: 'Ask',
        rawToolName: 'mcp__server__ask',
        input: { questions: [{ question: 'What next?', options: [] }] },
      })
    ).toBe('permission_request');
    expect(getPendingRequestType({ toolName: 'Bash', input: { command: 'ls' } })).toBe(
      'permission_request'
    );
  });
});
