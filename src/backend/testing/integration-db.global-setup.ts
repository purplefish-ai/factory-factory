import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '@/backend/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    integrationDatabaseTemplate: string;
  }
}

function migrationFingerprint(migrationsPath: string): string {
  const hash = createHash('sha256');
  const names = readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const sqlPath = join(migrationsPath, name, 'migration.sql');
    if (existsSync(sqlPath)) {
      hash.update(name).update('\0').update(readFileSync(sqlPath)).update('\0');
    }
  }
  return hash.digest('hex');
}

/** Migrate once per project; workers copy the closed database into private directories. */
export default function setupIntegrationDatabase(
  project: Pick<TestProject, 'provide' | 'onTestsRerun'> & {
    config: Pick<TestProject['config'], 'root'>;
  }
): () => void {
  const tempDir = mkdtempSync(join(tmpdir(), 'ff-integration-template-'));
  const databasePath = join(tempDir, 'template.db');
  const migrationsPath = join(project.config.root, 'prisma', 'migrations');
  const cleanup = () => rmSync(tempDir, { recursive: true, force: true });
  const migrate = (targetPath: string) => {
    // runMigrations closes its SQLite connection before returning, so all pages
    // are in this file and no live connection or WAL sidecar is copied.
    runMigrations({
      databasePath: targetPath,
      migrationsPath,
      log: () => {
        // No-op in tests.
      },
    });
  };

  try {
    let fingerprint = migrationFingerprint(migrationsPath);
    migrate(databasePath);
    project.provide('integrationDatabaseTemplate', databasePath);
    project.onTestsRerun(() => {
      const nextFingerprint = migrationFingerprint(migrationsPath);
      if (nextFingerprint === fingerprint) {
        return;
      }
      // Rebuild from scratch: incremental migration would skip edited SQL.
      // Publish only a complete, closed replacement; fail the rerun on errors.
      const candidatePath = join(tempDir, 'next-template.db');
      try {
        migrate(candidatePath);
        renameSync(candidatePath, databasePath);
        fingerprint = nextFingerprint;
      } finally {
        rmSync(candidatePath, { force: true });
      }
    });
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}
