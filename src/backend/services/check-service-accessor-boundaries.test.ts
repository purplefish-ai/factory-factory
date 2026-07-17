import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface SourceFileFixture {
  path: string;
  content: string;
}

describe('check-service-accessor-boundaries', () => {
  const tempDirs: string[] = [];
  const checkerScriptPath = path.join(
    process.cwd(),
    'scripts/check-service-accessor-boundaries.mjs'
  );

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function runChecker(sourceFiles: SourceFileFixture[]): {
    status: number | null;
    output: string;
  } {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'service-accessor-boundaries-'));
    tempDirs.push(tempRoot);

    for (const sourceFile of sourceFiles) {
      const fullPath = path.join(tempRoot, sourceFile.path);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, sourceFile.content);
    }

    const result = spawnSync('node', [checkerScriptPath], {
      cwd: tempRoot,
      encoding: 'utf8',
    });

    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  }

  it('allows owner-internal deep accessor imports', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/service/workspace-query.service.ts',
        content:
          "import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';\n",
      },
    ]);

    expect(result.status).toBe(0);
    expect(result.output).toContain('Service accessor boundaries check passed.');
  });

  it('ignores local export declarations without a module specifier', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/service/index.ts',
        content: 'const workspaceService = {};\nexport { workspaceService };\n',
      },
    ]);

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('TypeError');
  });

  it('rejects raw persistence accessor exports from capsule barrels', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content: "export * from './resources/workspace.accessor';\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('raw persistence accessor');
  });

  it('rejects type-only raw accessor imports from capsule barrels', () => {
    const result = runChecker([
      {
        path: 'src/backend/trpc/workspace.trpc.ts',
        content:
          "import type { workspaceAccessor } from '@/backend/services/workspace';\nexport type WorkspaceAccessor = typeof workspaceAccessor;\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('raw persistence accessor');
    expect(result.output).toContain('workspaceAccessor');
  });

  it('rejects cross-owner deep accessor imports', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/session/service/session.service.ts',
        content:
          "import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('cross-owner raw persistence accessor');
    expect(result.output).toContain('workspaceAccessor');
  });

  it('allows only the exact backup orchestration deep accessor import', () => {
    const allowed = runChecker([
      {
        path: 'src/backend/orchestration/data-backup.service.ts',
        content:
          "import { dataBackupAccessor } from '@/backend/services/settings/resources/data-backup.accessor';\n",
      },
    ]);
    const denied = runChecker([
      {
        path: 'src/backend/orchestration/data-backup-copy.service.ts',
        content:
          "import { dataBackupAccessor } from '@/backend/services/settings/resources/data-backup.accessor';\n",
      },
    ]);

    expect(allowed.status).toBe(0);
    expect(denied.status).toBe(1);
    expect(denied.output).toContain('cross-owner raw persistence accessor');
  });
});
