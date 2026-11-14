import { describe, expect, it } from 'vitest';
import { parseMetricsArgs } from './agent-metrics';

describe('parseMetricsArgs', () => {
  it('defaults to 300 pull requests and Markdown', () => {
    expect(parseMetricsArgs([])).toEqual({ pullRequests: 300, json: false, jsonFile: null });
  });

  it('reads --prs and --json', () => {
    expect(parseMetricsArgs(['--prs', '50', '--json'])).toEqual({
      pullRequests: 50,
      json: true,
      jsonFile: null,
    });
  });

  it('reads --json-file, which leaves the Markdown on standard output', () => {
    expect(parseMetricsArgs(['--json-file', 'agent-metrics.json'])).toEqual({
      pullRequests: 300,
      json: false,
      jsonFile: 'agent-metrics.json',
    });
  });

  it('rejects a missing or non-positive count, a missing path and unknown flags', () => {
    expect(() => parseMetricsArgs(['--prs'])).toThrow('--prs needs a positive integer');
    expect(() => parseMetricsArgs(['--prs', '0'])).toThrow('--prs needs a positive integer');
    expect(() => parseMetricsArgs(['--json-file'])).toThrow('--json-file needs a path');
    expect(() => parseMetricsArgs(['--json-file', '--json'])).toThrow('--json-file needs a path');
    expect(() => parseMetricsArgs(['--json-file', ''])).toThrow('--json-file needs a path');
    expect(() => parseMetricsArgs(['--markdown'])).toThrow('Unknown argument: --markdown');
  });
});
