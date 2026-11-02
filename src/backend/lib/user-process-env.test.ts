import { describe, expect, it } from 'vitest';
import { buildUserProcessEnv } from './user-process-env';

describe('buildUserProcessEnv', () => {
  it('drops the variables launchers set for Factory Factory and keeps the user env', () => {
    const env = buildUserProcessEnv({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      NODE_ENV: 'production',
      DATABASE_PATH: '/Users/me/factory-factory/data.db',
      BACKEND_PORT: '3001',
      FF_NODE_EXEC_PATH: '/Applications/Factory Factory.app/Contents/MacOS/Factory Factory',
    });

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/me' });
  });

  it('does not mutate the base environment', () => {
    const base = { NODE_ENV: 'production', PATH: '/usr/bin' };

    buildUserProcessEnv(base);

    expect(base).toEqual({ NODE_ENV: 'production', PATH: '/usr/bin' });
  });
});
