import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.mjs';

describe('command line', () => {
  it('parses arguments', () => {
    expect(parseArgs([])).toEqual({ mode: 'run', scenario: 'echo', keep: false });
    expect(parseArgs(['--scenario', 'slow-turn', '--keep'])).toEqual({
      mode: 'run',
      scenario: 'slow-turn',
      keep: true,
    });
    expect(parseArgs(['--clean']).mode).toBe('clean');
    expect(parseArgs(['--help']).mode).toBe('help');
    expect(() => parseArgs(['--scenario'])).toThrow();
    expect(() => parseArgs(['--scenario', '../x'])).toThrow();
    expect(() => parseArgs(['--clean', '--keep'])).toThrow();
    expect(() => parseArgs(['--port'])).toThrow();
  });
});
