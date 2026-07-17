import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('check-single-writer', () => {
  const tempDirs: string[] = [];
  const checkerScriptPath = path.join(process.cwd(), 'scripts/check-single-writer.mjs');
  const accessorSource = readFileSync(
    path.join(process.cwd(), 'src/backend/services/workspace/resources/workspace.accessor.ts'),
    'utf8'
  );
  const schemaSource = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createTempBackend(sourceFiles: Array<{ relPath: string; content: string }>): string {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'single-writer-'));
    tempDirs.push(tempRoot);

    writeBackendFixtureFiles(tempRoot);
    writeSourceFiles(tempRoot, sourceFiles);

    return tempRoot;
  }

  function writeBackendFixtureFiles(
    tempRoot: string,
    options: { accessorContent?: string; schemaContent?: string } = {}
  ): void {
    const accessorDir = path.join(tempRoot, 'src/backend/services/workspace/resources');
    mkdirSync(accessorDir, { recursive: true });
    writeFileSync(
      path.join(accessorDir, 'workspace.accessor.ts'),
      options.accessorContent ?? accessorSource
    );

    const prismaDir = path.join(tempRoot, 'prisma');
    mkdirSync(prismaDir, { recursive: true });
    writeFileSync(path.join(prismaDir, 'schema.prisma'), options.schemaContent ?? schemaSource);
  }

  function writeSourceFiles(
    tempRoot: string,
    sourceFiles: Array<{ relPath: string; content: string }>
  ): void {
    for (const file of sourceFiles) {
      const fullPath = path.join(tempRoot, file.relPath);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content);
    }
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

  it('flags unauthorized ratchet field writes via recordRatchetSessionEnd mutator', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/services/session/service/lifecycle/session.service.ts',
        content: `
          async function settleFromSession(workspaceAccessor) {
            await workspaceAccessor.recordRatchetSessionEnd('ws', 'session', 'DIED');
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

  it('allows workspace ratchet capability recordRatchetSessionEnd writes', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/services/workspace/service/lifecycle/workspace-ratchet.service.ts',
        content: `
          async function settleFromRatchet(workspaceAccessor) {
            await workspaceAccessor.recordRatchetSessionEnd('ws', 'session', 'DIED');
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(0);
  });

  it('allows creation service to own auto-iteration configuration writes', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/services/workspace/service/lifecycle/creation.service.ts',
        content: `
          async function createAutoIteration(workspaceAccessor) {
            await workspaceAccessor.update('ws', { autoIterationConfig: { maxIterations: 3 } });
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(0);
  });

  it('rejects orchestration writes to auto-iteration configuration', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/orchestration/domain-bridges.orchestrator.ts',
        content: `
          async function configure(workspaceAccessor) {
            await workspaceAccessor.update('ws', { autoIterationConfig: { maxIterations: 3 } });
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain('unauthorized write of workspace field "autoIterationConfig"');
  });

  it('checks ownership for updateMany payload mutators', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/services/session/service/lifecycle/session.service.ts',
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
        relPath: 'src/backend/services/session/service/lifecycle/session.repository.ts',
        content: `
          class SessionRepository {
            workspaces;

            constructor(workspaces) {
              this.workspaces = workspaces;
            }

            async clear(workspaceId, sessionId) {
              await this.workspaces.recordRatchetSessionEnd(workspaceId, sessionId, 'COMPLETED');
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

    writeBackendFixtureFiles(tempRoot, { accessorContent: accessorWithNewMutator });
    writeSourceFiles(tempRoot, [
      {
        relPath: 'src/backend/services/session/service/lifecycle/session.service.ts',
        content: 'export const marker = "noop";\n',
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'workspace mutator(s) missing from checker rules: unsafeExtraMutator'
    );
  });

  it('fails when a Workspace scalar field is missing ownership policy coverage', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/services/workspace/service/lifecycle/data.service.ts',
        content: 'export const marker = "noop";\n',
      },
    ]);

    const schemaPath = path.join(tempRoot, 'prisma/schema.prisma');
    const schemaWithNewField = schemaSource.replace(
      '  stateComputedAt     DateTime?         // Last kanban column computation',
      '  stateComputedAt     DateTime?         // Last kanban column computation\n  uncheckedMutableField String?'
    );
    writeFileSync(schemaPath, schemaWithNewField);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'Workspace field(s) missing ownership policy: uncheckedMutableField'
    );
  });
});
