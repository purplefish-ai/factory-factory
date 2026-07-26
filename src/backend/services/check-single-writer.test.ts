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

  it('flags unauthorized field writes made through a wrapper mutator', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/services/session/service/lifecycle/session.service.ts',
        content: `
          async function markActivity(workspaceAccessor) {
            await workspaceAccessor.markHasHadSessions('ws');
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain('unauthorized write of workspace field "hasHadSessions"');
  });

  // The PR aggregate mutators now write one Workspace column -- the branch name a
  // refresh may correct. The rest of what they carry lands on WorkspacePR, which
  // this checker does not police because nothing else can name those columns.
  it('checks ownership through public PR aggregate dispatch-reset mutators', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/services/session/service/lifecycle/session.service.ts',
        content: `
          async function writeSnapshots(workspaceAccessor) {
            await workspaceAccessor.applyPrSnapshotWithDispatchReset('ws', {
              prNumber: 1,
              prUpdatedAt: new Date(),
              branchName: 'feature/actual-head',
            });
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain('unauthorized write of workspace field "branchName"');
  });

  it('allows workspace PR snapshot capability dispatch-reset writes', () => {
    const tempRoot = createTempBackend([
      {
        relPath:
          'src/backend/services/workspace/service/lifecycle/workspace-pr-snapshot.service.ts',
        content: `
          async function writeSnapshots(workspaceAccessor) {
            await workspaceAccessor.applyPrSnapshotWithDispatchReset('ws', {
              prNumber: 1,
              prUpdatedAt: new Date(),
              branchName: 'feature/actual-head',
            });
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(0);
  });

  describe('owned side tables', () => {
    // These tables were split off Workspace, so the field-ownership table cannot
    // police them. dep-cruiser lets any file under services/*/resources/ import
    // prisma, so without this rule a second accessor could write them freely.
    it('rejects a WorkspacePR write from another accessor in the same directory', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/services/workspace/resources/other.accessor.ts',
          content: `
            import { prisma } from '@/backend/db';
            async function sneak(id) {
              await prisma.workspacePR.updateMany({ where: { workspaceId: id }, data: { state: 'MERGED' } });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(1);
      expect(result.output).toContain('unauthorized write to workspacePR via updateMany()');
    });

    it('rejects a WorkspaceRatchet write from outside its accessor', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/services/ratchet/resources/ratchet.accessor.ts',
          content: `
            import { prisma } from '@/backend/db';
            async function disable(id) {
              await prisma.workspaceRatchet.update({ where: { workspaceId: id }, data: { enabled: false } });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(1);
      expect(result.output).toContain('unauthorized write to workspaceRatchet via update()');
    });

    // Prisma exposes nine writes per model, not seven. These two were missing
    // from SIDE_TABLE_WRITE_METHODS, which left a way to write any of the four
    // owned tables from any file -- unused today, and unpoliced.
    it.each([
      'createManyAndReturn',
      'updateManyAndReturn',
    ])('rejects a %s write from outside the owning accessor', (method) => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/services/workspace/resources/other.accessor.ts',
          content: `
              import { prisma } from '@/backend/db';
              async function write() {
                return await prisma.workspaceRunScript.${method}({ data: [{ workspaceId: 'ws' }] });
              }
            `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(1);
      expect(result.output).toContain(`unauthorized write to workspaceRunScript via ${method}()`);
    });

    it('allows the owning accessor its own writes', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/services/workspace/resources/workspace-pr.accessor.ts',
          content: `
            import { prisma } from '@/backend/db';
            async function write(id) {
              await prisma.workspacePR.updateMany({ where: { workspaceId: id }, data: { state: 'MERGED' } });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(0);
    });

    it('allows any file to read a side table', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/services/workspace/resources/other.accessor.ts',
          content: `
            import { prisma } from '@/backend/db';
            async function read(id) {
              return await prisma.workspacePR.findUnique({ where: { workspaceId: id } });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(0);
    });

    it('rejects a nested update of the pr relation', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/services/workspace/resources/other.accessor.ts',
          content: `
            import { prisma } from '@/backend/db';
            async function sneak(id) {
              await prisma.workspace.update({ where: { id }, data: { pr: { update: { state: 'MERGED' } } } });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(1);
      expect(result.output).toContain('unauthorized nested update of the workspacePR relation');
    });

    it('rejects a nested upsert of the ratchet relation', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/orchestration/some.orchestrator.ts',
          content: `
            async function sneak(tx, id) {
              await tx.workspace.update({ where: { id }, data: { ratchet: { upsert: { create: {}, update: {} } } } });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(1);
      expect(result.output).toContain(
        'unauthorized nested upsert of the workspaceRatchet relation'
      );
    });

    // All three rows are created with their workspace and have to be, or the
    // row-guarded writes would skip it. Restoring a backup creates them the same
    // way, before any accessor could reach the rows.
    it('allows nested creation of all three rows alongside a workspace', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/orchestration/data-backup.service.ts',
          content: `
            async function restore(tx, projectId) {
              await tx.workspace.create({
                data: {
                  projectId,
                  name: 'x',
                  pr: { create: { url: null } },
                  ratchet: { create: { enabled: true } },
                  runScript: { create: { command: 'pnpm dev' } },
                },
              });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(0);
    });

    // The exemption above is for creating a workspace, not for the `create` key.
    // Prisma accepts a nested `create` in an *update* payload too, and that one
    // inserts caller-chosen column values into a row the owning accessor never
    // saw -- the single write path the blanket `create` exemption used to allow.
    it('rejects a nested create of a side table in a workspace update', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/orchestration/data-backup.service.ts',
          content: `
            async function reinstate(tx, id) {
              await tx.workspace.update({
                where: { id },
                data: { runScript: { create: { status: 'RUNNING', pid: 4242 } } },
              });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(1);
      expect(result.output).toContain(
        'unauthorized nested create of the workspaceRunScript relation'
      );
    });

    // The creation exemption follows the call, not the file: a file that legally
    // creates a workspace does not thereby earn a second write path.
    it('rejects a nested create in an update beside a legitimate workspace create', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/orchestration/data-backup.service.ts',
          content: `
            async function restore(tx, projectId, id) {
              await tx.workspace.create({
                data: { projectId, name: 'x', runScript: { create: { command: 'pnpm dev' } } },
              });
              await tx.workspace.update({
                where: { id },
                data: { pr: { create: { url: 'https://example.test/pr/1' } } },
              });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(1);
      expect(result.output).toContain('unauthorized nested create of the workspacePR relation');
      expect(result.output).not.toContain('workspaceRunScript');
    });

    // The exemption is one call's own `data:` payload, not everything textually
    // inside it. An argument expression can contain an entire `workspace.update()`,
    // and that update is not creating anything.
    it('rejects a nested create in an update evaluated inside a create argument', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/orchestration/data-backup.service.ts',
          content: `
            async function restore(tx, projectId, id) {
              await tx.workspace.create({
                data: {
                  projectId,
                  name: 'x',
                  runScript: { create: { command: 'pnpm dev' } },
                  description: label(
                    await tx.workspace.update({
                      where: { id },
                      data: { pr: { create: { url: 'https://example.test/pr/1' } } },
                    })
                  ),
                },
              });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(1);
      expect(result.output).toContain('unauthorized nested create of the workspacePR relation');
      expect(result.output).not.toContain('workspaceRunScript');
    });

    // What has to be the creation's own is the `data:` key, not the whole
    // argument: spreading other options in alongside it is still that call's
    // payload. The guard reads `data:` off the first argument, so this stays
    // exempt while a `data:` belonging to some other call does not.
    it('allows a nested create when the create argument spreads other options in', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/orchestration/data-backup.service.ts',
          content: `
            async function restore(tx) {
              await tx.workspace.create({
                ...selectOptions(),
                data: { name: 'x', runScript: { create: { command: 'pnpm dev' } } },
              });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(0);
    });

    // `pr: { url: null }` under `where:` is a relation filter, not a write. The
    // PR accessor's own compare-and-swaps depend on those.
    it('allows relation filters that name a side table in a where clause', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/services/workspace/resources/other.accessor.ts',
          content: `
            import { prisma } from '@/backend/db';
            async function read(id) {
              return await prisma.workspace.findMany({
                where: { id, pr: { url: null }, ratchet: { enabled: true } },
              });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(0);
    });

    it('allows writes through a transaction client in the owning accessor', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/services/workspace/resources/workspace-pr.accessor.ts',
          content: `
            async function write(transaction, id) {
              await transaction.workspacePR.updateMany({ where: { workspaceId: id }, data: {} });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(0);
    });

    it('rejects writes through a transaction client elsewhere', () => {
      const tempRoot = createTempBackend([
        {
          relPath: 'src/backend/services/workspace/resources/workspace.accessor.ts',
          content: `
            async function write(transaction, id) {
              await transaction.workspacePR.updateMany({ where: { workspaceId: id }, data: {} });
            }
          `,
        },
      ]);

      const result = runChecker(tempRoot);

      expect(result.status).toBe(1);
      expect(result.output).toContain('unauthorized write to workspacePR via updateMany()');
    });
  });

  it('allows the run-script capability its own compare-and-swap writes', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/services/workspace/service/lifecycle/workspace-run-script.service.ts',
        content: `
          async function markRunning(workspaceAccessor) {
            await workspaceAccessor.casRunScriptStatusUpdate('ws', 'STARTING', {
              runScriptStatus: 'RUNNING',
            });
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(0);
  });

  // Auto-iteration's five fields left `Workspace` for `WorkspaceAutoIteration`,
  // so the field-ownership rules that used to police `autoIterationConfig` are
  // gone and OWNED_SIDE_TABLES polices the table instead. These two cover the
  // same invariant at its new home.
  it('allows the auto-iteration row to be created alongside its workspace', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/services/workspace/service/lifecycle/creation.service.ts',
        content: `
          async function createAutoIteration(prisma, projectId) {
            await prisma.workspace.create({
              data: {
                projectId,
                name: 'x',
                autoIteration: { create: { mode: 'AUTO_ITERATION', config: { maxIterations: 3 } } },
              },
            });
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(0);
  });

  it('rejects orchestration writes to the auto-iteration table', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/orchestration/domain-bridges.orchestrator.ts',
        content: `
          import { prisma } from '@/backend/db';
          async function configure(workspaceId) {
            await prisma.workspaceAutoIteration.updateMany({
              where: { workspaceId },
              data: { config: { maxIterations: 3 } },
            });
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain('unauthorized write to workspaceAutoIteration');
  });

  it('checks ownership for updateMany payload mutators', () => {
    const tempRoot = createTempBackend([
      {
        relPath: 'src/backend/services/session/service/lifecycle/session.service.ts',
        content: `
          async function transition(workspaceAccessor) {
            await workspaceAccessor.transitionWithCas('ws', 'READY', { initRetryCount: 0 });
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain('unauthorized write of workspace field "initRetryCount"');
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
              await this.workspaces.markHasHadSessions(workspaceId);
            }
          }
        `,
      },
    ]);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain('unauthorized write of workspace field "hasHadSessions"');
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
      data: { prReviewLastCommentId: null },
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
      '  // Activity tracking\n  hasHadSessions      Boolean           @default(false)',
      '  // Activity tracking\n  hasHadSessions      Boolean           @default(false)\n  uncheckedMutableField String?'
    );
    writeFileSync(schemaPath, schemaWithNewField);

    const result = runChecker(tempRoot);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'Workspace field(s) missing ownership policy: uncheckedMutableField'
    );
  });
});
