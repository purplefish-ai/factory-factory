import { describe, expect, it } from 'vitest';
import { buildUserProcessEnv } from './user-process-env';

describe('buildUserProcessEnv', () => {
  it('drops the variables launchers set for Factory Factory and keeps the user env', () => {
    const env = buildUserProcessEnv({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      NODE_ENV: 'production',
      DATABASE_PATH: '/Users/me/factory-factory/data.db',
      MIGRATIONS_PATH: '/Applications/Factory Factory.app/prisma/migrations',
      BACKEND_HOST: '127.0.0.1',
      BACKEND_PORT: '3001',
      FRONTEND_PORT: '3000',
      FRONTEND_STATIC_PATH: '/Applications/Factory Factory.app/dist/client',
      WS_LOGS_PATH: '/Users/me/factory-factory/ws-logs',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
      DISABLE_CORS_CHECKS: 'true',
      TRUST_PROXY_HEADERS: 'true',
      DOTENV_CONFIG_OVERRIDE: 'true',
      DOTENV_OVERRIDE: 'true',
      FF_RUN_SCRIPT_PROXY_ENABLED: 'true',
      FF_EMIT_BACKEND_PORT: '1',
      FF_TAILSCALE_ORIGIN: 'https://mac.tail123.ts.net',
      FF_TAILSCALE_HTTPS_PORT: '443',
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
