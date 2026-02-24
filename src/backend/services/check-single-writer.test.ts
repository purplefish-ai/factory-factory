import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('check-single-writer', () => {
  const tempDirs: string[] = [];
  const checkerScriptPath = path.join(process.cwd(), 'scripts/check-single-writer.mjs');
  const accessorSource = readFileSync(
    path.join(process.cwd(), 'src/backend/resource_accessors/workspace.accessor.ts'),
    'utf8'
  );

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createTempBackend(sourceFiles: Array<{ relPath: string; content: string }>): string {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'single-writer-'));
    tempDirs.push(tempRoot);

    const accessorDir = path.join(tempRoot, 'src/backend/resource_accessors');
    mkdirSync(accessorDir, { recursive: true });
    writeFileSync(path.join(accessorDir, 'workspace.accessor.ts'), accessorSource);

    for (const file of sourceFiles) {
      const fullPath = path.join(tempRoot, file.relPath);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content);
    }

    return tempRoot;
  }

  function runChecker(rootDir: string): { status: number | null; output: string } {
    const result = spawnSync('node', [checkerScriptPath], {
      cwd: rootDir,
      encoding: 'utf8',
    });

    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  }

  it('flags unauthorized ratchet field writes via clearRatchetActiveSession mutator', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/domains/session/lifecycle/session.service.ts',
        content: `
          async function clearFromSession(workspaceAccessor) {
            await workspaceAccessor.clearRatchetActiveSession('ws', 'session');
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'unauthorized write of workspace field "ratchetActiveSessionId"'
    );
  });

  it('allows ratchet-owned clearRatchetActiveSession writes', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/domains/ratchet/ratchet.service.ts',
        content: `
          async function clearFromRatchet(workspaceAccessor) {
            await workspaceAccessor.clearRatchetActiveSession('ws', 'session');
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(0);
  });

  it('checks ownership for updateMany payload mutators', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/domains/session/lifecycle/session.service.ts',
        content: `
          async function transition(workspaceAccessor) {
            await workspaceAccessor.transitionWithCas('ws', 'READY', { ratchetState: 'IDLE' });
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain('unauthorized write of workspace field "ratchetState"');
  });

  it('analyzes this.workspaces mutator calls without crashing', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/domains/session/lifecycle/session.repository.ts',
        content: `
          class SessionRepository {
            workspaces;

            constructor(workspaces) {
              this.workspaces = workspaces;
            }

            async clear(workspaceId, sessionId) {
              await this.workspaces.clearRatchetActiveSession(workspaceId, sessionId);
            }
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'unauthorized write of workspace field "ratchetActiveSessionId"'
    );
    expect(result.output).not.toContain('TypeError');
  });

  it('fails when a new workspace mutator is missing checker coverage rules', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'single-writer-'));
    tempDirs.push(tempRoot);

    const accessorDir = path.join(tempRoot, 'src/backend/resource_accessors');
    mkdirSync(accessorDir, { recursive: true });

    const accessorWithNewMutator = accessorSource.replace(
      '\n}\n\nexport const workspaceAccessor = new WorkspaceAccessor();\n',
      `
  async unsafeExtraMutator(id: string): Promise<void> {
    await prisma.workspace.updateMany({
      where: { id },
      data: { ratchetActiveSessionId: null },
    });
  }
}

export const workspaceAccessor = new WorkspaceAccessor();
`
    );

    writeFileSync(path.join(accessorDir, 'workspace.accessor.ts'), accessorWithNewMutator);
    const sessionDir = path.join(tempRoot, 'src/backend/domains/session/lifecycle');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, 'session.service.ts'), 'export const marker = "noop";\n');

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'workspace mutator(s) missing from checker rules: unsafeExtraMutator'
    );
  });
});
