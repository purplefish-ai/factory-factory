import { describe, expect, it } from 'vitest';
import { computePendingRequestType } from './pending-request-type';

describe('computePendingRequestType', () => {
  it('returns plan_approval when any session has ExitPlanMode pending', () => {
    const result = computePendingRequestType(
      ['s1', 's2'],
      new Map([
        ['s1', { toolName: 'ReadFile' }],
        ['s2', { toolName: 'ExitPlanMode' }],
      ])
    );

    expect(result).toBe('plan_approval');
  });

  it('returns user_question when any session has AskUserQuestion pending', () => {
    const result = computePendingRequestType(
      ['s1', 's2'],
      new Map([
        ['s1', { toolName: 'AskUserQuestion' }],
        ['s2', { toolName: 'ReadFile' }],
      ])
    );

    expect(result).toBe('user_question');
  });

  it('returns user_question when tool input payload contains questions', () => {
    const result = computePendingRequestType(
      ['s1', 's2'],
      new Map([
        ['s1', { toolName: 'Tool input request', input: { questions: [{ question: 'Q1' }] } }],
        ['s2', { toolName: 'ReadFile' }],
      ])
    );

    expect(result).toBe('user_question');
  });

  it('returns permission_request when a generic permission request exists', () => {
    const result = computePendingRequestType(
      ['s1', 's2'],
      new Map([
        ['s1', { toolName: 'ReadFile' }],
        ['s2', { toolName: 'WriteFile' }],
      ])
    );

    expect(result).toBe('permission_request');
  });

  it('prioritizes user_question over generic permission requests', () => {
    const result = computePendingRequestType(
      ['s1', 's2'],
      new Map([
        ['s1', { toolName: 'ReadFile' }],
        ['s2', { toolName: 'AskUserQuestion' }],
      ])
    );

    expect(result).toBe('user_question');
  });

  it('returns null when no pending requests exist', () => {
    const result = computePendingRequestType(['s1', 's2'], new Map());
    expect(result).toBeNull();
  });
});
