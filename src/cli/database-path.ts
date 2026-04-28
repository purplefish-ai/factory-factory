import { join, resolve } from 'node:path';
import { expandEnvVars, getDefaultBaseDir } from '@/backend/lib/env';

interface ResolveDatabasePathOptions {
  databasePath?: string;
  env?: Record<string, string | undefined>;
}

export function getDefaultDatabasePath(): string {
  return join(getDefaultBaseDir(), 'data.db');
}

export function resolveDatabasePath({
  databasePath,
  env = process.env,
}: ResolveDatabasePathOptions = {}): string {
  const configuredPath =
    databasePath ||
    (env.DATABASE_PATH ? expandEnvVars(env.DATABASE_PATH, env) : undefined) ||
    join(getBaseDir(env), 'data.db');
  return resolve(configuredPath);
}

function getBaseDir(env: Record<string, string | undefined>): string {
  return env.BASE_DIR ? expandEnvVars(env.BASE_DIR, env) : getDefaultBaseDir();
}
