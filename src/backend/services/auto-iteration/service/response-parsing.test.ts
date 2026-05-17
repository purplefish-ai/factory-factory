import { describe, expect, it } from 'vitest';
import { parseCritiqueResult, parseMetricEvaluation } from './response-parsing';

describe('auto-iteration response parsing', () => {
  it('parses metric evaluation JSON from surrounding text', () => {
    const result = parseMetricEvaluation(
      'Result:\n```json\n{"metricSummary":"12 passing tests","improved":true,"targetReached":false}\n```'
    );

    expect(result).toEqual({
      metricSummary: '12 passing tests',
      improved: true,
      targetReached: false,
    });
  });

  it('falls back to a rejected metric evaluation when JSON is absent', () => {
    const result = parseMetricEvaluation('plain text response');

    expect(result).toEqual({
      metricSummary: 'plain text response',
      improved: false,
      targetReached: false,
    });
  });

  it('rejects critique responses that cannot be parsed', () => {
    const result = parseCritiqueResult('not json');

    expect(result).toEqual({
      approved: false,
      notes: 'Could not parse critique response: not json',
    });
  });
});
