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
    });
  });

  it('sets development mode when requested', () => {
    const env = buildServeEnv({ dev: true, host: '127.0.0.1' }, '/tmp/factory.db', 3100, 3101, {});

    expect(env.NODE_ENV).toBe('development');
    expect(env.BACKEND_HOST).toBe('127.0.0.1');
  });
});
