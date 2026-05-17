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

  it('ignores braces inside JSON strings while finding the object boundary', () => {
    const result = parseMetricEvaluation(
      'Result: {"metricSummary":"kept { nested } text and an escaped quote: \\"ok\\"","improved":true,"targetReached":true} trailing'
    );

    expect(result).toEqual({
      metricSummary: 'kept { nested } text and an escaped quote: "ok"',
      improved: true,
      targetReached: true,
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

  it('treats non-boolean metric flags as false', () => {
    const result = parseMetricEvaluation(
      '{"metricSummary":"string flags","improved":"false","targetReached":"true"}'
    );

    expect(result).toEqual({
      metricSummary: 'string flags',
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

  it('treats non-boolean critique approval as false', () => {
    const result = parseCritiqueResult('{"approved":"false","notes":"not approved"}');

    expect(result).toEqual({
      approved: false,
      notes: 'not approved',
    });
  });
});
