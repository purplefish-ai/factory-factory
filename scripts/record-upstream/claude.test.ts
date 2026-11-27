import { describe, expect, it } from 'vitest';
import { isolatedShell } from './claude.mjs';

describe('isolatedShell', () => {
  it('uses zsh, whose startup files the empty ZDOTDIR replaces', () => {
    expect(isolatedShell(() => true)).toBe('/bin/zsh');
  });

  it('refuses to record Claude without zsh rather than lose the shell isolation', () => {
    expect(() => isolatedShell(() => false)).toThrow(/needs \/bin\/zsh/);
  });
});
