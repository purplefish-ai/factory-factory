import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configService } from './config.service';

const ORIGINAL_ENV = { ...process.env };

describe('configService environment accessors', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configService.reload();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configService.reload();
  });

  it('reads backend host from validated config', () => {
    process.env.BACKEND_HOST = '127.0.0.1';
    configService.reload();

    expect(configService.getBackendHost()).toBe('127.0.0.1');
  });

  it('returns undefined for blank backend host', () => {
    process.env.BACKEND_HOST = '   ';
    configService.reload();

    expect(configService.getBackendHost()).toBeUndefined();
  });

  it('defaults shell path when SHELL is not provided', () => {
    Reflect.deleteProperty(process.env, 'SHELL');
    configService.reload();

    expect(configService.getShellPath()).toBe('/bin/bash');
  });

  it('reads migrations path from validated config', () => {
    process.env.MIGRATIONS_PATH = '/tmp/migrations';
    configService.reload();

    expect(configService.getMigrationsPath()).toBe('/tmp/migrations');
  });
});
