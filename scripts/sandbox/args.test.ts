import { describe, expect, it } from 'vitest';
import { parseArgs, USAGE } from './args.mjs';

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

  it('states what the sandbox contains and what it does not', () => {
    const text = USAGE.replace(/\s+/g, ' ');
    expect(text).not.toContain('every other outbound');
    expect(text).toContain(
      "the application's built-in fetch and http/https requests, git over HTTP(S) and the Claude runtime are refused and recorded"
    );
    expect(text).toContain('git over SSH and gh are refused by shims');
    expect(text).toContain(
      'WebSocket clients and clients that bring their own agent are not proxied, and the sandbox relies on them having no credential (voice) or being switched off (Slack)'
    );
    const section = USAGE.split('What the sandbox does not contain:\n')[1]?.split('\n\n')[0] ?? '';
    expect(section.split('\n').length).toBeLessThanOrEqual(12);
    for (const residual of [
      'WebSocket',
      'custom agents',
      'raw TCP',
      'docker',
      'ssh run by absolute path',
      '~/.ssh',
      'keychain',
      'not a boundary against a hostile agent',
      'SIGKILLed launcher',
      'CODEX_PATH',
    ]) {
      expect(section.replace(/\s+/g, ' ')).toContain(residual);
    }
  });
});
