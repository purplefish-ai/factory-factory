import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Expand environment variables in a string.
 * Handles $VAR and ${VAR} syntax, including $USER.
 */
function expandEnvVars(value: string): string {
  // Replace $USER with actual home directory username
  let result = value.replace(/\$USER|\$\{USER\}/g, homedir().split('/').pop() || 'user');

  // Replace other environment variables
  result = result.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue !== undefined) {
      return expandEnvVars(envValue);
    }
    return match;
  });

  return result;
}

// Get database path from environment or use default
function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) {
    const url = expandEnvVars(process.env.DATABASE_URL);
    // Ensure it starts with file: for SQLite
    return url.startsWith('file:') ? url : `file:${url}`;
  }

  if (process.env.DATABASE_PATH) {
    return `file:${expandEnvVars(process.env.DATABASE_PATH)}`;
  }

  // Use BASE_DIR if set, otherwise default to home directory
  const rawBaseDir = process.env.BASE_DIR;
  const baseDir = rawBaseDir ? expandEnvVars(rawBaseDir) : join(homedir(), 'factory-factory');
  return `file:${join(baseDir, 'data.db')}`;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: getDatabaseUrl(),
  },
});
