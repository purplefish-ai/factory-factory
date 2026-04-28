import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface ResolveDatabasePathOptions {
  databasePath?: string;
  env?: Record<string, string | undefined>;
}

export function getDefaultDatabasePath(): string {
  return join(homedir(), 'factory-factory', 'data.db');
}

export function resolveDatabasePath({
  databasePath,
  env = process.env,
}: ResolveDatabasePathOptions = {}): string {
  const configuredPath = databasePath || env.DATABASE_PATH || getDefaultDatabasePath();
  return resolve(configuredPath);
}
