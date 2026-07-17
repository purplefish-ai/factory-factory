import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TRPC_ROOT = resolve(process.cwd(), 'src/backend/trpc');

const TRPC_RUNTIME_FILES = [
  ...readdirSync(TRPC_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.trpc.ts'))
    .map((entry) => relative(process.cwd(), join(entry.parentPath, entry.name))),
  'src/backend/trpc/workspace/workspace-helpers.ts',
].sort();

const FORBIDDEN_TRPC_RUNTIME_BINDINGS = [
  'autoIterationService',
  'cryptoService',
  'dataBackupService',
  'decisionLogQueryService',
  'gitCloneService',
  'githubCLIService',
  'insightsService',
  'linearClientService',
  'logbookService',
  'periodicTaskAccessor',
  'prSnapshotService',
  'projectManagementService',
  'ratchetService',
  'runScriptConfigPersistenceService',
  'sessionDataService',
  'sessionProviderResolverService',
  'userSettingsQueryService',
  'workspaceAccessor',
  'workspaceActivityService',
  'workspaceDataService',
  'workspaceNotificationAccessor',
  'workspaceQueryService',
] as const;

describe('tRPC context dependencies', () => {
  it.each(TRPC_RUNTIME_FILES)('%s uses context runtime dependencies', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    const valueImports = source.matchAll(
      /import\s+(?!type\b)([\s\S]*?)\s+from\s+['"](@\/backend\/(?:services|orchestration|db)(?:\/[^'"]*)?)['"]/g
    );

    for (const [, bindings] of valueImports) {
      expect(bindings).not.toMatch(
        new RegExp(`\\b(?:${FORBIDDEN_TRPC_RUNTIME_BINDINGS.join('|')})\\b`)
      );
    }
  });
});
