import { describe, expect, it } from 'vitest';
import { extractPlanToolResult } from './tool-result-plan';

describe('extractPlanToolResult', () => {
  it('returns null for non-json text content', () => {
    expect(extractPlanToolResult('command output')).toBeNull();
  });

  it('extracts markdown from plan JSON payload strings', () => {
    const payload = JSON.stringify({
      type: 'plan',
      text: '# Plan\n\n1. Step one',
    });

    expect(extractPlanToolResult(payload)).toEqual({
      planText: '# Plan\n\n1. Step one',
      rawText: payload,
    });
  });

  it('extracts markdown from fenced plan JSON', () => {
    const payload = '```json\n{"type":"plan","text":"# Plan\\n\\n- Step"}\n```';

    expect(extractPlanToolResult(payload)).toEqual({
      planText: '# Plan\n\n- Step',
      rawText: payload,
    });
  });

  it('extracts markdown from text items in tool-result arrays', () => {
    const payload = JSON.stringify({
      type: 'plan',
      plan: { content: [{ type: 'text', text: '# Nested Plan\n\n- Item' }] },
    });

    expect(extractPlanToolResult([{ type: 'text', text: payload }])).toEqual({
      planText: '# Nested Plan\n\n- Item',
      rawText: payload,
    });
  });

  it('returns null for JSON payloads without a plan envelope', () => {
    const payload = JSON.stringify({ type: 'tool_result', text: '# Not a plan' });
    expect(extractPlanToolResult(payload)).toBeNull();
  });

  it('returns null for metadata-only plan payloads', () => {
    const payload = JSON.stringify({
      type: 'plan',
      id: 'item_plan_approval',
      status: 'completed',
    });

    expect(extractPlanToolResult(payload)).toBeNull();
    expect(extractPlanToolResult([{ type: 'text', text: payload }])).toBeNull();
  });

  it('returns null when explicit plan fields contain no plan text', () => {
    const blankPayload = JSON.stringify({
      type: 'plan',
      id: 'item_plan_approval',
      text: '   ',
    });
    const nestedMetadataPayload = JSON.stringify({
      type: 'plan',
      plan: { id: 'item_nested_plan', status: 'completed' },
    });

    expect(extractPlanToolResult(blankPayload)).toBeNull();
    expect(extractPlanToolResult(nestedMetadataPayload)).toBeNull();
  });
});
