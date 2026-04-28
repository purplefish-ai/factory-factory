import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

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

function getDefaultBaseDir(): string {
  return join(homedir(), 'factory-factory');
}

function getBaseDir(env: Record<string, string | undefined>): string {
  return env.BASE_DIR ? expandEnvVars(env.BASE_DIR, env) : getDefaultBaseDir();
}

function expandEnvVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/gi, (match, braced, bare) => {
    const varName = braced || bare;
    const envValue = env[varName];
    if (envValue !== undefined) {
      return envValue;
    }

    if (varName.toUpperCase() === 'USER') {
      return basename(homedir()) || 'user';
    }

    return match;
  });
}
