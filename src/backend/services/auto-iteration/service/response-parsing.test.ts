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

  it('parses explicit string metric flags', () => {
    const result = parseMetricEvaluation(
      '{"metricSummary":"string flags","improved":"false","targetReached":"true"}'
    );

    expect(result).toEqual({
      metricSummary: 'string flags',
      improved: false,
      targetReached: true,
    });
  });

  it('parses numeric true metric flags without treating other numbers as true', () => {
    const result = parseMetricEvaluation(
      '{"metricSummary":"numeric flags","improved":1,"targetReached":2}'
    );

    expect(result).toEqual({
      metricSummary: 'numeric flags',
      improved: true,
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

  it('accepts explicit string true critique approval', () => {
    const result = parseCritiqueResult('{"approved":"true","notes":"approved"}');

    expect(result).toEqual({
      approved: true,
      notes: 'approved',
    });
  });
});
