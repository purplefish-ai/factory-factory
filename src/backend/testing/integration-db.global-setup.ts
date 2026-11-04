import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '@/backend/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    integrationDatabaseTemplate: string;
  }
}

/** Migrate once per project; workers copy the closed database into private directories. */
export default function setupIntegrationDatabase(
  project: Pick<TestProject, 'provide'> & { config: Pick<TestProject['config'], 'root'> }
): () => void {
  const tempDir = mkdtempSync(join(tmpdir(), 'ff-integration-template-'));
  const databasePath = join(tempDir, 'template.db');
  const cleanup = () => rmSync(tempDir, { recursive: true, force: true });

  try {
    // runMigrations closes its SQLite connection before returning, so all pages
    // are in this file and no live connection or WAL sidecar is copied.
    runMigrations({
      databasePath,
      migrationsPath: join(project.config.root, 'prisma', 'migrations'),
      log: () => {
        // No-op in tests.
      },
    });
    project.provide('integrationDatabaseTemplate', databasePath);
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}
