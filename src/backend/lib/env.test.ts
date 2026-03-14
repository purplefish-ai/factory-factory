import { homedir } from 'node:os';
import { basename } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandEnvVars } from './env';

const ORIGINAL_ENV = { ...process.env };

describe('expandEnvVars', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('expands both braced and unbraced variables', () => {
    process.env.HOME = '/tmp/home';
    const bracedHomeToken = '$' + '{HOME}/data';

    expect(expandEnvVars('$HOME/data')).toBe('/tmp/home/data');
    expect(expandEnvVars(bracedHomeToken)).toBe('/tmp/home/data');
  });

  it('does not partially expand variables that start with USER', () => {
    process.env.USER = 'alice';
    process.env.USER_DATA = '/tmp/user-data';
    Reflect.deleteProperty(process.env, 'USER_OTHER');

    expect(expandEnvVars('$USER_DATA')).toBe('/tmp/user-data');
    expect(expandEnvVars('$USER_OTHER')).toBe('$USER_OTHER');
  });

  it('keeps stray closing braces as literal characters', () => {
    process.env.TEST_VAR = '/tmp/value';

    expect(expandEnvVars('$TEST_VAR}')).toBe('/tmp/value}');
    expect(expandEnvVars('$MISSING_VAR}')).toBe('$MISSING_VAR}');
  });

  it('does not recursively expand env values', () => {
    process.env.A = '$HOME';
    process.env.HOME = '/tmp/home';

    expect(expandEnvVars('$A')).toBe('$HOME');
  });

  it('preserves dollar sequences in replacement values', () => {
    process.env.USER = '$&-$1-$$';

    expect(expandEnvVars('$USER')).toBe('$&-$1-$$');
  });

  it('falls back to homedir username when USER is unset', () => {
    Reflect.deleteProperty(process.env, 'USER');
    const bracedUserToken = '$' + '{USER}';

    expect(expandEnvVars('$USER')).toBe(basename(homedir()) || 'user');
    expect(expandEnvVars(bracedUserToken)).toBe(basename(homedir()) || 'user');
  });
});
