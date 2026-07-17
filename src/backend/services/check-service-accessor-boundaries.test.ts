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

  it('rejects locally imported accessors re-exported from capsule barrels', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content:
          "import { workspaceAccessor } from './resources/workspace.accessor';\nexport { workspaceAccessor };\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('raw persistence accessor');
    expect(result.output).toContain('workspaceAccessor');
  });

  it('rejects local accessor aliases re-exported from capsule barrels', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content:
          "import { workspaceAccessor } from './resources/workspace.accessor';\nconst persistence = workspaceAccessor;\nexport { persistence };\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('raw persistence accessor');
    expect(result.output).toContain('workspaceAccessor');
  });

  it('rejects exported variable declarations that alias accessors', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content:
          "import { workspaceAccessor } from './resources/workspace.accessor';\nexport const persistence = workspaceAccessor;\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('raw persistence accessor');
    expect(result.output).toContain('workspaceAccessor');
  });

  it('rejects accessor alias chains re-exported from capsule barrels', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content:
          "import { workspaceAccessor } from './resources/workspace.accessor';\nconst store = workspaceAccessor;\nconst persistence = store;\nexport { persistence };\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('raw persistence accessor');
    expect(result.output).toContain('workspaceAccessor');
  });

  it.each([
    ['parenthesized', '(workspaceAccessor)'],
    ['type asserted', 'workspaceAccessor as typeof workspaceAccessor'],
    ['non-null asserted', 'workspaceAccessor!'],
    ['satisfies constrained', 'workspaceAccessor satisfies object'],
  ])('rejects %s accessor aliases re-exported from capsule barrels', (_label, initializer) => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content: `import { workspaceAccessor } from './resources/workspace.accessor';\nconst persistence = ${initializer};\nexport { persistence };\n`,
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('raw persistence accessor');
    expect(result.output).toContain('workspaceAccessor');
  });

  it.each([
    ['parenthesized', '(workspaceAccessor)'],
    ['type asserted', 'workspaceAccessor as typeof workspaceAccessor'],
  ])('rejects %s accessor default exports from capsule barrels', (_label, expression) => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content: `import { workspaceAccessor } from './resources/workspace.accessor';\nexport default ${expression};\n`,
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('raw persistence accessor');
    expect(result.output).toContain('workspaceAccessor');
  });

  it('rejects locally imported accessor namespaces re-exported from capsule barrels', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content:
          "import * as persistence from './resources/workspace.accessor';\nexport { persistence };\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('raw persistence accessor');
    expect(result.output).toContain('workspaceAccessor');
  });

  it('rejects accessor namespace exports from capsule barrels', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content: "export * as persistence from './resources/workspace.accessor';\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('raw persistence accessor');
    expect(result.output).toContain('workspaceAccessor');
  });

  it('rejects indirect named and star accessor re-exports from capsule barrels', () => {
    const named = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content: "export { workspaceAccessor } from './service/reexports';\n",
      },
      {
        path: 'src/backend/services/workspace/service/reexports.ts',
        content: "export { workspaceAccessor } from '../resources/workspace.accessor';\n",
      },
    ]);
    const star = runChecker([
      {
        path: 'src/backend/services/workspace/index.ts',
        content: "export * from './service/reexports';\n",
      },
      {
        path: 'src/backend/services/workspace/service/reexports.ts',
        content: "export { workspaceAccessor } from '../resources/workspace.accessor';\n",
      },
    ]);

    expect(named.status).toBe(1);
    expect(named.output).toContain('workspaceAccessor');
    expect(star.status).toBe(1);
    expect(star.output).toContain('workspaceAccessor');
  });

  it('rejects accessor aliases declared in resource modules and re-exported from barrels', () => {
    const namedAlias = runChecker([
      {
        path: 'src/backend/services/workspace/resources/workspace.accessor.ts',
        content: 'const workspaceAccessor = {};\nexport { workspaceAccessor as persistence };\n',
      },
      {
        path: 'src/backend/services/workspace/service/reexports.ts',
        content:
          "export { persistence as workspaceStore } from '../resources/workspace.accessor';\n",
      },
      {
        path: 'src/backend/services/workspace/index.ts',
        content: "export { workspaceStore } from './service/reexports';\n",
      },
    ]);
    const defaultAlias = runChecker([
      {
        path: 'src/backend/services/workspace/resources/workspace.accessor.ts',
        content: 'const workspaceAccessor = {};\nexport default workspaceAccessor;\n',
      },
      {
        path: 'src/backend/services/workspace/service/reexports.ts',
        content: "export { default as persistence } from '../resources/workspace.accessor';\n",
      },
      {
        path: 'src/backend/services/workspace/index.ts',
        content: "export { persistence } from './service/reexports';\n",
      },
    ]);

    expect(namedAlias.status).toBe(1);
    expect(namedAlias.output).toContain('workspaceAccessor');
    expect(defaultAlias.status).toBe(1);
    expect(defaultAlias.output).toContain('workspaceAccessor');
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

  it('rejects cross-owner accessor references in import types', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/resources.integration.test.ts',
        content:
          "let accessor: typeof import('@/backend/services/session/resources/agent-session.accessor').agentSessionAccessor;\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('cross-owner raw persistence accessor');
    expect(result.output).toContain('agentSessionAccessor');
  });

  it('rejects cross-owner dynamic imports of accessor modules', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/resources.integration.test.ts',
        content:
          "async function load() { return import('@/backend/services/terminal/resources/terminal-session.accessor'); }\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('cross-owner raw persistence accessor');
    expect(result.output).toContain('terminalSessionAccessor');
  });

  it('rejects accessor module strings passed to loader calls', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/resources.integration.test.ts',
        content:
          "await vi.importActual('@/backend/services/session/resources/closed-session.accessor');\n",
      },
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('cross-owner raw persistence accessor');
    expect(result.output).toContain('closedSessionAccessor');
  });

  it('allows ordinary capsule barrel mocks with accessor-shaped properties', () => {
    const result = runChecker([
      {
        path: 'src/backend/services/ratchet/service/fixer-session.service.test.ts',
        content:
          "vi.mock('@/backend/services/session', () => ({ agentSessionAccessor: { findById: vi.fn() } }));\n",
      },
    ]);

    expect(result.status).toBe(0);
    expect(result.output).toContain('Service accessor boundaries check passed.');
  });

  it.each([
    'js',
    'mjs',
    'cjs',
  ])('normalizes .%s runtime extensions to TypeScript module identity', (extension) => {
    const result = runChecker([
      {
        path: 'src/backend/services/session/service/session.service.ts',
        content: `import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor.${extension}';\n`,
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

  it('does not extend the backup import exception to accessor re-exports', () => {
    const direct = runChecker([
      {
        path: 'src/backend/orchestration/data-backup.service.ts',
        content:
          "export { dataBackupAccessor } from '@/backend/services/settings/resources/data-backup.accessor';\n",
      },
    ]);
    const importedThenExported = runChecker([
      {
        path: 'src/backend/orchestration/data-backup.service.ts',
        content:
          "import { dataBackupAccessor } from '@/backend/services/settings/resources/data-backup.accessor';\nexport { dataBackupAccessor };\n",
      },
    ]);

    expect(direct.status).toBe(1);
    expect(direct.output).toContain('cross-owner raw persistence accessor');
    expect(direct.output).toContain('dataBackupAccessor');
    expect(importedThenExported.status).toBe(1);
    expect(importedThenExported.output).toContain('cross-owner re-export');
    expect(importedThenExported.output).toContain('dataBackupAccessor');
  });
});
