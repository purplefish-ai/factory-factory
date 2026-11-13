import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.mjs';

describe('command line', () => {
  it('parses arguments', () => {
    expect(parseArgs([])).toEqual({
      mode: 'run',
      scenario: 'echo',
      keep: false,
      ownerPid: null,
      ttlMinutes: 120,
    });
    expect(parseArgs(['--scenario', 'slow-turn', '--keep'])).toEqual({
      mode: 'run',
      scenario: 'slow-turn',
      keep: true,
      ownerPid: null,
      ttlMinutes: 120,
    });
    expect(parseArgs(['--clean']).mode).toBe('clean');
    expect(parseArgs(['--help']).mode).toBe('help');
    expect(() => parseArgs(['--scenario'])).toThrow();
    expect(() => parseArgs(['--scenario', '../x'])).toThrow();
    expect(() => parseArgs(['--clean', '--keep'])).toThrow();
    expect(() => parseArgs(['--port'])).toThrow();
  });

  it('parses the owner process and the time to live', () => {
    expect(parseArgs(['--owner-pid', '4321', '--ttl-minutes', '30'])).toMatchObject({
      ownerPid: 4321,
      ttlMinutes: 30,
    });
    expect(parseArgs(['--ttl-minutes', '0']).ttlMinutes).toBe(0);
    for (const bad of [
      ['--owner-pid'],
      ['--owner-pid', '1'],
      ['--owner-pid', 'x'],
      ['--ttl-minutes', '-1'],
      ['--ttl-minutes', '1.5'],
      ['--ttl-minutes'],
    ]) {
      expect(() => parseArgs(bad)).toThrow();
    }
    expect(() => parseArgs(['--clean', '--owner-pid', '4321'])).toThrow();
    expect(() => parseArgs(['--clean', '--ttl-minutes', '5'])).toThrow();
  });
});
