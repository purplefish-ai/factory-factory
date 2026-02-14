import { describe, expect, it } from 'vitest';
import { extractPlanText } from './plan-content';

describe('extractPlanText', () => {
  it('returns plain markdown plans unchanged', () => {
    const plan = '# Plan\n\n1. Do it';
    expect(extractPlanText(plan)).toBe(plan);
  });

  it('extracts plan from JSON string payload', () => {
    const payload = JSON.stringify({ plan: '# Plan\n\n- Step A' });
    expect(extractPlanText(payload)).toBe('# Plan\n\n- Step A');
  });

  it('extracts nested plan from JSON object payload', () => {
    const payload = {
      plan: {
        content: [{ type: 'text', text: '# Nested Plan\n\n- Step B' }],
      },
    };
    expect(extractPlanText(payload)).toBe('# Nested Plan\n\n- Step B');
  });

  it('extracts plan from fenced JSON string', () => {
    const payload = '```json\n{"plan":"# Fenced Plan\\n\\n- Step C"}\n```';
    expect(extractPlanText(payload)).toBe('# Fenced Plan\n\n- Step C');
  });

  it('returns null when no textual plan content exists', () => {
    const payload = { foo: 1, bar: { baz: true } };
    expect(extractPlanText(payload)).toBeNull();
  });
});
