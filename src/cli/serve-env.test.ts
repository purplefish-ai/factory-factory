import { describe, expect, it } from 'vitest';
import { buildServeEnv } from './serve-env';

describe('buildServeEnv', () => {
  it('passes the requested CLI host to the backend bind host', () => {
    const env = buildServeEnv({ host: 'localhost' }, '/tmp/factory.db', 3000, 3001, {
      EXISTING: 'value',
    });

    expect(env).toMatchObject({
      EXISTING: 'value',
      DATABASE_PATH: '/tmp/factory.db',
      FRONTEND_PORT: '3000',
      BACKEND_HOST: 'localhost',
      BACKEND_PORT: '3001',
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3001',
    });
  });

  it('sets development mode when requested', () => {
    const env = buildServeEnv({ dev: true, host: '127.0.0.1' }, '/tmp/factory.db', 3100, 3101, {});

    expect(env.NODE_ENV).toBe('development');
    expect(env.BACKEND_HOST).toBe('127.0.0.1');
    expect(env.CORS_ALLOWED_ORIGINS).toBe('http://127.0.0.1:3100');
  });

  it('sets CORS_ALLOWED_ORIGINS to the frontend origin in dev mode', () => {
    const env = buildServeEnv({ dev: true, host: 'localhost' }, '/tmp/factory.db', 3504, 3503, {});

    expect(env.CORS_ALLOWED_ORIGINS).toBe('http://localhost:3504');
  });

  it('uses localhost for the default CORS origin when binding production to all interfaces', () => {
    const env = buildServeEnv({ host: '0.0.0.0' }, '/tmp/factory.db', 3000, 7001, {});

    expect(env.BACKEND_HOST).toBe('0.0.0.0');
    expect(env.CORS_ALLOWED_ORIGINS).toBe('http://localhost:7001');
  });

  it.each([
    '::',
    '::0',
    '0:0:0:0:0:0:0:0',
  ])('uses localhost for the default CORS origin when binding production to IPv6 all-interfaces host %s', (host) => {
    const env = buildServeEnv({ host }, '/tmp/factory.db', 3000, 7001, {});

    expect(env.BACKEND_HOST).toBe(host);
    expect(env.CORS_ALLOWED_ORIGINS).toBe('http://localhost:7001');
  });

  it('uses localhost for the default CORS origin when binding dev mode to all interfaces', () => {
    const env = buildServeEnv({ dev: true, host: '0.0.0.0' }, '/tmp/factory.db', 5173, 7001, {});

    expect(env.BACKEND_HOST).toBe('0.0.0.0');
    expect(env.CORS_ALLOWED_ORIGINS).toBe('http://localhost:5173');
  });

  it('uses localhost for the default CORS origin when binding dev mode to IPv6 all interfaces', () => {
    const env = buildServeEnv({ dev: true, host: '::' }, '/tmp/factory.db', 5173, 7001, {});

    expect(env.BACKEND_HOST).toBe('::');
    expect(env.CORS_ALLOWED_ORIGINS).toBe('http://localhost:5173');
  });

  it('respects CORS_ALLOWED_ORIGINS from the base environment', () => {
    const env = buildServeEnv({ host: '0.0.0.0' }, '/tmp/factory.db', 3000, 3001, {
      CORS_ALLOWED_ORIGINS: 'https://home.adeesha.dev',
    });

    expect(env.CORS_ALLOWED_ORIGINS).toBe('https://home.adeesha.dev');
  });
});
