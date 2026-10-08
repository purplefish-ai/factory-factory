import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CIStatus,
  PRState,
  type Prisma,
  type PrismaClient,
  RunScriptStatus,
  WorkspaceStatus,
} from '@prisma-gen/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let prisma: PrismaClient;

let workspaceDataService: typeof import('@/backend/services/workspace').workspaceDataService;
let workspaceAutoIterationService: typeof import('@/backend/services/workspace').workspaceAutoIterationService;
let workspaceMaintenanceService: typeof import('@/backend/services/workspace').workspaceMaintenanceService;
let workspacePRMonitoringService: typeof import('@/backend/services/workspace').workspacePRMonitoringService;
let workspaceRunScriptService: typeof import('@/backend/services/workspace').workspaceRunScriptService;
let workspaceStateMachine: typeof import('@/backend/services/workspace').workspaceStateMachine;
let projectManagementService: typeof import('@/backend/services/workspace').projectManagementService;
let terminalSessionService: typeof import('@/backend/services/terminal').terminalSessionService;
let userSettingsService: typeof import('@/backend/services/settings').userSettingsService;
let decisionLogService: typeof import('@/backend/services/decision-log').decisionLogService;

let counter = 0;
const tempRepoDirs = new Set<string>();

beforeAll(async () => {
  db = await createIntegrationDatabase();
  prisma = db.prisma;

  ({
    projectManagementService,
    workspaceAutoIterationService,
    workspaceDataService,
    workspaceMaintenanceService,
    workspacePRMonitoringService,
    workspaceRunScriptService,
    workspaceStateMachine,
  } = await vi.importActual<typeof import('@/backend/services/workspace')>(
    '@/backend/services/workspace'
  ));
  ({ terminalSessionService } = await vi.importActual<typeof import('@/backend/services/terminal')>(
    '@/backend/services/terminal'
  ));
  ({ userSettingsService } = await vi.importActual<typeof import('@/backend/services/settings')>(
    '@/backend/services/settings'
  ));
  ({ decisionLogService } = await vi.importActual<typeof import('@/backend/services/decision-log')>(
    '@/backend/services/decision-log'
  ));
}, 30_000);

afterEach(async () => {
  await clearIntegrationDatabase(prisma);

  for (const repoDir of tempRepoDirs) {
    rmSync(repoDir, { recursive: true, force: true });
    tempRepoDirs.delete(repoDir);
  }

  vi.restoreAllMocks();
});

afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

async function createProjectFixture(overrides: Partial<Prisma.ProjectUncheckedCreateInput> = {}) {
  const slug = (overrides.slug as string | undefined) ?? nextId('project');
  return await prisma.project.create({
    data: {
      name: `Project ${slug}`,
      slug,
      repoPath: `/tmp/${slug}`,
      worktreeBasePath: `/tmp/worktrees/${slug}`,
      defaultBranch: 'main',
      ...overrides,
    },
  });
}

async function createWorkspaceFixture(
  projectId: string,
  overrides: Partial<Prisma.WorkspaceUncheckedCreateInput> & {
    ratchet?: Prisma.WorkspacePRMonitoringCreateWithoutWorkspaceInput;
    pr?: Prisma.WorkspacePRCreateWithoutWorkspaceInput;
    runScript?: Prisma.WorkspaceRunScriptCreateWithoutWorkspaceInput;
    autoIteration?: Prisma.WorkspaceAutoIterationCreateWithoutWorkspaceInput;
  } = {}
) {
  const { ratchet, pr, runScript, autoIteration, ...workspaceOverrides } = overrides;
  return await prisma.workspace.create({
    data: {
      projectId,
      name: nextId('workspace'),
      status: WorkspaceStatus.NEW,
      ...workspaceOverrides,
      // Mirrors workspaceAccessor.create: every workspace gets all four
      // side-table rows, so the row-guarded writes under test have one to guard.
      prMonitoring: { create: ratchet ?? {} },
      prDiscovery: { create: {} },
      prs: { create: pr ? [pr] : [] },
      runScript: { create: runScript ?? {} },
      autoIteration: { create: autoIteration ?? {} },
    },
  });
}

function createGitRepository(remoteUrl?: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'ff-repo-'));
  tempRepoDirs.add(repoDir);

  execFileSync('git', ['init'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'integration@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Integration Test'], { cwd: repoDir });

  if (remoteUrl) {
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: repoDir });
  }

  return repoDir;
}

function createGitCommit(repoPath: string): void {
  execFileSync('git', ['commit', '--allow-empty', '-m', 'Initial commit'], { cwd: repoPath });
}

function setOriginHead(repoPath: string, branch: string): void {
  execFileSync('git', ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], { cwd: repoPath });
  execFileSync(
    'git',
    ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`],
    {
      cwd: repoPath,
    }
  );
}

async function findWorkspaceOrThrow(workspaceId: string) {
  const workspace = await workspaceDataService.findById(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return workspace;
}

describe('resource accessors integration', () => {
  describe('workspace services', () => {
    it('persists validated status transitions through the state machine', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id, { status: WorkspaceStatus.NEW });

      await workspaceStateMachine.transition(workspace.id, WorkspaceStatus.PROVISIONING);
      await workspaceStateMachine.transition(workspace.id, WorkspaceStatus.READY);

      const reloaded = await findWorkspaceOrThrow(workspace.id);

      expect(reloaded.status).toBe(WorkspaceStatus.READY);
    });

    it('enforces compare-and-swap run script transitions', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id, {
        runScript: { status: RunScriptStatus.IDLE },
      });

      const started = await workspaceRunScriptService.transitionStatusIfCurrent(
        workspace.id,
        RunScriptStatus.IDLE,
        {
          runScriptStatus: RunScriptStatus.STARTING,
        }
      );

      const duplicate = await workspaceRunScriptService.transitionStatusIfCurrent(
        workspace.id,
        RunScriptStatus.IDLE,
        {
          runScriptStatus: RunScriptStatus.RUNNING,
        }
      );

      const reloaded = await findWorkspaceOrThrow(workspace.id);
      expect(started.count).toBe(1);
      expect(duplicate.count).toBe(0);
      expect(reloaded.runScriptStatus).toBe(RunScriptStatus.STARTING);
    });

    it('only retries failed provisioning workspaces under retry budget', async () => {
      const project = await createProjectFixture();
      const eligible = await createWorkspaceFixture(project.id, {
        status: WorkspaceStatus.FAILED,
        initRetryCount: 1,
      });
      const maxed = await createWorkspaceFixture(project.id, {
        status: WorkspaceStatus.FAILED,
        initRetryCount: 3,
      });

      const eligibleResult = await workspaceStateMachine.startProvisioning(eligible.id, {
        maxRetries: 3,
      });
      const maxedResult = await workspaceStateMachine.startProvisioning(maxed.id, {
        maxRetries: 3,
      });

      const eligibleReloaded = await findWorkspaceOrThrow(eligible.id);
      const maxedReloaded = await findWorkspaceOrThrow(maxed.id);

      expect(eligibleResult).not.toBeNull();
      expect(maxedResult).toBeNull();
      expect(eligibleReloaded.status).toBe(WorkspaceStatus.PROVISIONING);
      expect(eligibleReloaded.initRetryCount).toBe(2);
      expect(maxedReloaded.status).toBe(WorkspaceStatus.FAILED);
    });

    it('selects NEW and stale PROVISIONING workspaces for reconciliation', async () => {
      const project = await createProjectFixture();
      const staleStartedAt = new Date(Date.now() - 12 * 60 * 1000);

      const newWorkspace = await createWorkspaceFixture(project.id, {
        status: WorkspaceStatus.NEW,
      });
      const staleProvisioning = await createWorkspaceFixture(project.id, {
        status: WorkspaceStatus.PROVISIONING,
        initStartedAt: staleStartedAt,
      });
      await createWorkspaceFixture(project.id, {
        status: WorkspaceStatus.PROVISIONING,
        initStartedAt: new Date(),
      });

      const needingWorktree = await workspaceMaintenanceService.findNeedingWorktree();
      const ids = new Set(needingWorktree.map((workspace) => workspace.id));

      expect(ids.has(newWorkspace.id)).toBe(true);
      expect(ids.has(staleProvisioning.id)).toBe(true);
      expect(
        needingWorktree.some((workspace) => workspace.status === WorkspaceStatus.PROVISIONING)
      ).toBe(true);
    });

    it('projects ratchetState from the PR row on every read, with no state column', async () => {
      const project = await createProjectFixture();

      const conflicted = await createWorkspaceFixture(project.id, {
        status: WorkspaceStatus.READY,
        pr: {
          url: 'https://github.com/acme/repo/pull/10',
          number: 10,
          state: PRState.OPEN,
          ciStatus: CIStatus.SUCCESS,
          hasMergeConflict: true,
        },
        ratchet: { enabled: true },
      });

      // A conflict on a green PR: only `hasMergeConflict` records it, and before
      // the projection nothing recorded it at all — the derived `MERGE_CONFLICT`
      // enum was the sole trace and it did not survive a restart.
      await expect(workspaceDataService.findById(conflicted.id)).resolves.toMatchObject({
        prHasMergeConflict: true,
        ratchetState: 'MERGE_CONFLICT',
      });

      // Disabling is the whole transition: no settling write follows it, and the
      // very next read already says IDLE.
      await workspacePRMonitoringService.setBinding({
        workspaceId: conflicted.id,
        enabled: false,
        recipientSessionId: null,
        expectedBindingRevision: 0,
      });
      await expect(workspaceDataService.findById(conflicted.id)).resolves.toMatchObject({
        ratchetEnabled: false,
        ratchetState: 'IDLE',
      });

      // Re-enabling restores the projection rather than resuming a stored value.
      await workspacePRMonitoringService.setBinding({
        workspaceId: conflicted.id,
        enabled: true,
        recipientSessionId: null,
        expectedBindingRevision: 1,
      });
      await expect(workspaceDataService.findById(conflicted.id)).resolves.toMatchObject({
        ratchetEnabled: true,
        ratchetState: 'MERGE_CONFLICT',
      });
    });

    it('truncates init output when max size is exceeded', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      await workspaceRunScriptService.appendInitOutput(workspace.id, 'a'.repeat(80), 50);

      const reloaded = await findWorkspaceOrThrow(workspace.id);
      expect(reloaded.initOutput).toBeTruthy();
      expect((reloaded.initOutput || '').length).toBeLessThanOrEqual(50);
      expect(reloaded.initOutput?.startsWith('[...truncated...]\n')).toBe(true);
    });

    it('preserves all chunks across concurrent init output appends', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);
      const chunks = Array.from({ length: 40 }, (_, index) => `chunk-${index}\n`);

      await Promise.all(
        chunks.map((chunk) =>
          workspaceRunScriptService.appendInitOutput(workspace.id, chunk, 10 * 1024)
        )
      );

      const reloaded = await findWorkspaceOrThrow(workspace.id);
      const output = reloaded.initOutput ?? '';

      expect(output.length).toBeGreaterThan(0);
      expect(output.startsWith('[...truncated...]\n')).toBe(false);
      for (const chunk of chunks) {
        expect(output.includes(chunk)).toBe(true);
      }
    });

    it('updates updatedAt when appending init output via raw SQL', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);
      const staleUpdatedAt = new Date('2000-01-01T00:00:00.000Z');

      await prisma.$executeRaw`
        UPDATE "Workspace"
        SET "updatedAt" = ${staleUpdatedAt}
        WHERE "id" = ${workspace.id}
      `;

      await workspaceRunScriptService.appendInitOutput(workspace.id, 'hello\n');

      const reloaded = await findWorkspaceOrThrow(workspace.id);
      expect(reloaded.updatedAt.getTime()).toBeGreaterThan(staleUpdatedAt.getTime());
    });

    it('clears auto-iteration session only when the expected pointer still matches', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id, {
        autoIteration: { sessionId: 'session-1' },
      });

      await expect(
        workspaceAutoIterationService.clearSessionIfMatching(workspace.id, 'different-session')
      ).resolves.toBe(false);
      expect((await findWorkspaceOrThrow(workspace.id)).autoIterationSessionId).toBe('session-1');

      await expect(
        workspaceAutoIterationService.clearSessionIfMatching(workspace.id, 'session-1')
      ).resolves.toBe(true);
      expect((await findWorkspaceOrThrow(workspace.id)).autoIterationSessionId).toBeNull();
    });
  });

  describe('projectManagementService', () => {
    it('auto-detects GitHub owner/repo from git remote during create', async () => {
      const repoPath = createGitRepository('git@github.com:purplefish-ai/factory-factory.git');

      const project = await projectManagementService.create(
        {
          repoPath,
        },
        {
          worktreeBaseDir: '/tmp/worktrees',
        }
      );

      expect(project.githubOwner).toBe('purplefish-ai');
      expect(project.githubRepo).toBe('factory-factory');
    });

    it('auto-detects default branch from origin HEAD during create', async () => {
      const repoPath = createGitRepository('git@github.com:purplefish-ai/factory-factory.git');
      createGitCommit(repoPath);
      setOriginHead(repoPath, 'unstable');

      const project = await projectManagementService.create(
        {
          repoPath,
        },
        {
          worktreeBaseDir: '/tmp/worktrees',
        }
      );

      expect(project.defaultBranch).toBe('unstable');
    });

    it('falls back to local HEAD when origin HEAD is unavailable during create', async () => {
      const repoPath = createGitRepository();
      execFileSync('git', ['checkout', '-b', 'develop'], { cwd: repoPath });

      const project = await projectManagementService.create(
        {
          repoPath,
        },
        {
          worktreeBaseDir: '/tmp/worktrees',
        }
      );

      expect(project.defaultBranch).toBe('develop');
    });

    it('falls back to main when default branch cannot be detected during create', async () => {
      const repoPath = mkdtempSync(join(tmpdir(), 'ff-nongit-'));
      tempRepoDirs.add(repoPath);

      const project = await projectManagementService.create(
        {
          repoPath,
        },
        {
          worktreeBaseDir: '/tmp/worktrees',
        }
      );

      expect(project.defaultBranch).toBe('main');
    });

    it('retries slug creation when a slug collision occurs', async () => {
      const repoPath = createGitRepository();

      const first = await projectManagementService.create(
        {
          repoPath,
        },
        {
          worktreeBaseDir: '/tmp/worktrees',
        }
      );

      const second = await projectManagementService.create(
        {
          repoPath,
        },
        {
          worktreeBaseDir: '/tmp/worktrees',
        }
      );

      expect(first.slug).not.toBe(second.slug);
      expect(second.slug).toBe(`${first.slug}-2`);
    });

    it('validates repository paths against git metadata', async () => {
      const gitRepo = createGitRepository();
      const nonGitDir = mkdtempSync(join(tmpdir(), 'ff-nongit-'));
      tempRepoDirs.add(nonGitDir);

      const valid = await projectManagementService.validateRepoPath(gitRepo);
      const invalid = await projectManagementService.validateRepoPath(nonGitDir);
      const missing = await projectManagementService.validateRepoPath('/path/that/does/not/exist');

      expect(valid.valid).toBe(true);
      expect(invalid.valid).toBe(false);
      expect(invalid.error).toContain('not a git repository');
      expect(missing.valid).toBe(false);
      expect(missing.error).toContain('does not exist');
    });
  });

  describe('terminalSessionService', () => {
    it('clears pid only for matching terminal names in the requested workspace', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);
      const otherWorkspace = await createWorkspaceFixture(project.id);

      await prisma.terminalSession.createMany({
        data: [
          { workspaceId: workspace.id, name: 'terminal-a', pid: 1001 },
          { workspaceId: workspace.id, name: 'terminal-a', pid: 2002 },
          { workspaceId: workspace.id, name: 'terminal-b', pid: 3003 },
          { workspaceId: otherWorkspace.id, name: 'terminal-a', pid: 4004 },
        ],
      });

      await terminalSessionService.releaseSessionPid(workspace.id, 'terminal-a');

      const all = await prisma.terminalSession.findMany({ orderBy: { name: 'asc' } });
      const target = all.filter(
        (session) => session.workspaceId === workspace.id && session.name === 'terminal-a'
      );
      const untouchedName = all.find((session) => session.name === 'terminal-b');
      const untouchedWorkspace = all.find(
        (session) => session.workspaceId === otherWorkspace.id && session.name === 'terminal-a'
      );

      expect(target.every((session) => session.pid === null)).toBe(true);
      expect(untouchedName?.pid).toBe(3003);
      expect(untouchedWorkspace?.pid).toBe(4004);
    });

    it('finds only terminal sessions with a live pid', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      const live = await prisma.terminalSession.create({
        data: { workspaceId: workspace.id, name: 'live', pid: 999 },
      });
      await prisma.terminalSession.create({
        data: { workspaceId: workspace.id, name: 'idle', pid: null },
      });

      const withPid = await terminalSessionService.listPidBackedSessions();

      expect(withPid.map((session) => session.id)).toEqual([live.id]);
    });
  });

  describe('userSettingsService', () => {
    it('creates defaults on first read', async () => {
      const settings = await userSettingsService.get();

      expect(settings.userId).toBe('default');
      expect(settings.preferredIde).toBe('cursor');
      expect(settings.playSoundOnComplete).toBe(true);
      expect(settings.defaultClaudeModel).toBe('sonnet');
      expect(settings.defaultCodexModel).toBe('default');
    });

    it('returns one default row for concurrent first reads', async () => {
      const settings = await Promise.all(
        Array.from({ length: 10 }, () => userSettingsService.get())
      );

      expect(new Set(settings.map((row) => row.id)).size).toBe(1);
      expect(await prisma.userSettings.count({ where: { userId: 'default' } })).toBe(1);
    });

    it('persists workspace order by project id', async () => {
      const projectA = await createProjectFixture();
      const projectB = await createProjectFixture();

      await userSettingsService.updateWorkspaceOrder(projectA.id, ['ws-3', 'ws-1']);
      await userSettingsService.updateWorkspaceOrder(projectB.id, ['ws-9']);

      const orderA = await userSettingsService.getWorkspaceOrder(projectA.id);
      const orderB = await userSettingsService.getWorkspaceOrder(projectB.id);

      expect(orderA).toEqual(['ws-3', 'ws-1']);
      expect(orderB).toEqual(['ws-9']);
    });

    it('retries stale workspace order writes and preserves concurrent project entries', async () => {
      const projectA = await createProjectFixture();
      const projectB = await createProjectFixture();
      await userSettingsService.get();

      type UserSettingsUpdateManyResult = ReturnType<typeof prisma.userSettings.updateMany>;
      const originalUpdateMany = prisma.userSettings.updateMany.bind(prisma.userSettings);
      let injectedConcurrentUpdate = false;
      const updateManySpy = vi
        .spyOn(prisma.userSettings, 'updateMany')
        .mockImplementation((args): UserSettingsUpdateManyResult => {
          if (!injectedConcurrentUpdate) {
            injectedConcurrentUpdate = true;

            return prisma.userSettings
              .findUniqueOrThrow({
                where: { userId: 'default' },
              })
              .then((currentSettings) =>
                prisma.userSettings.update({
                  where: { userId: 'default' },
                  data: {
                    workspaceOrder: { [projectB.id]: ['ws-9'] },
                    updatedAt: new Date(currentSettings.updatedAt.getTime() + 1000),
                  },
                })
              )
              .then(() => originalUpdateMany(args)) as UserSettingsUpdateManyResult;
          }

          return originalUpdateMany(args);
        });

      await userSettingsService.updateWorkspaceOrder(projectA.id, ['ws-3', 'ws-1']);

      const settings = await prisma.userSettings.findUniqueOrThrow({
        where: { userId: 'default' },
      });

      expect(updateManySpy).toHaveBeenCalledTimes(2);
      expect(settings.workspaceOrder).toEqual({
        [projectB.id]: ['ws-9'],
        [projectA.id]: ['ws-3', 'ws-1'],
      });
    });
  });

  describe('decisionLogService', () => {
    it('lists recent logs scoped by agent id', async () => {
      await prisma.decisionLog.create({
        data: { agentId: 'agent-1', decision: 'Decision A', reasoning: 'Reason A' },
      });
      await prisma.decisionLog.create({
        data: { agentId: 'agent-2', decision: 'Decision B', reasoning: 'Reason B' },
      });
      await prisma.decisionLog.create({
        data: { agentId: 'agent-1', decision: 'Decision C', reasoning: 'Reason C' },
      });

      const agentOne = await decisionLogService.list({ agentId: 'agent-1', limit: 10 });
      const all = await decisionLogService.list({ limit: 10 });

      expect(agentOne).toHaveLength(2);
      expect(agentOne.every((entry) => entry.agentId === 'agent-1')).toBe(true);
      expect(all).toHaveLength(3);
    });
  });
});
