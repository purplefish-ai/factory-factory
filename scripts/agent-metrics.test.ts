import { describe, expect, it } from 'vitest';
import { parseMetricsArgs } from './agent-metrics';

describe('parseMetricsArgs', () => {
  it('defaults to 300 pull requests and Markdown', () => {
    expect(parseMetricsArgs([])).toEqual({ pullRequests: 300, json: false });
  });

  it('reads --prs and --json', () => {
    expect(parseMetricsArgs(['--prs', '50', '--json'])).toEqual({ pullRequests: 50, json: true });
  });

  it('rejects a missing or non-positive count and unknown flags', () => {
    expect(() => parseMetricsArgs(['--prs'])).toThrow('--prs needs a positive integer');
    expect(() => parseMetricsArgs(['--prs', '0'])).toThrow('--prs needs a positive integer');
    expect(() => parseMetricsArgs(['--markdown'])).toThrow('Unknown argument: --markdown');
  });
});
