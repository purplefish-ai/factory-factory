import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CIStatus,
  KanbanColumn,
  PRState,
  type Prisma,
  type PrismaClient,
  RatchetState,
  RunScriptStatus,
  SessionStatus,
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
let workspaceRatchetService: typeof import('@/backend/services/workspace').workspaceRatchetService;
let workspaceRunScriptService: typeof import('@/backend/services/workspace').workspaceRunScriptService;
let workspaceStateMachine: typeof import('@/backend/services/workspace').workspaceStateMachine;
let projectManagementService: typeof import('@/backend/services/workspace').projectManagementService;
let sessionDataService: typeof import('@/backend/services/session').sessionDataService;
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
    workspaceRatchetService,
    workspaceRunScriptService,
    workspaceStateMachine,
  } = await vi.importActual<typeof import('@/backend/services/workspace')>(
    '@/backend/services/workspace'
  ));
  ({ sessionDataService } = await vi.importActual<typeof import('@/backend/services/session')>(
    '@/backend/services/session'
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
  overrides: Partial<Prisma.WorkspaceUncheckedCreateInput> = {}
) {
  return await prisma.workspace.create({
    data: {
      projectId,
      name: nextId('workspace'),
      status: WorkspaceStatus.NEW,
      ...overrides,
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
        runScriptStatus: RunScriptStatus.IDLE,
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
        cachedKanbanColumn: KanbanColumn.WAITING,
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
      expect(eligibleReloaded.cachedKanbanColumn).toBe(KanbanColumn.WORKING);
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

    it('filters ratchet workspaces by READY + PR + ratchet state', async () => {
      const project = await createProjectFixture();

      const included = await createWorkspaceFixture(project.id, {
        status: WorkspaceStatus.READY,
        prUrl: 'https://github.com/acme/repo/pull/1',
        prNumber: 1,
        prState: PRState.OPEN,
        prCiStatus: CIStatus.PENDING,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_RUNNING,
      });

      await createWorkspaceFixture(project.id, {
        status: WorkspaceStatus.READY,
        prUrl: 'https://github.com/acme/repo/pull/2',
        ratchetEnabled: false,
      });

      await createWorkspaceFixture(project.id, {
        status: WorkspaceStatus.READY,
        prUrl: 'https://github.com/acme/repo/pull/3',
        ratchetEnabled: true,
        ratchetState: RatchetState.MERGED,
      });

      const ratchetCandidates = await workspaceRatchetService.findCandidates();

      expect(ratchetCandidates.map((workspace) => workspace.id)).toEqual([included.id]);
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

    it('settles ratchet session end only when session id matches', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id, {
        ratchetActiveSessionId: 'session-1',
      });

      const mismatch = await workspaceRatchetService.recordSessionEnd(
        workspace.id,
        'different-session',
        'DIED'
      );
      expect(mismatch).toBe(false);
      const unchanged = await findWorkspaceOrThrow(workspace.id);
      expect(unchanged.ratchetActiveSessionId).toBe('session-1');
      expect(unchanged.ratchetDispatchOutcome).toBeNull();

      const settled = await workspaceRatchetService.recordSessionEnd(
        workspace.id,
        'session-1',
        'DIED'
      );
      expect(settled).toBe(true);
      const cleared = await findWorkspaceOrThrow(workspace.id);
      expect(cleared.ratchetActiveSessionId).toBeNull();
      expect(cleared.ratchetDispatchOutcome).toBe('DIED');
    });

    it('clears auto-iteration session only when the expected pointer still matches', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id, {
        autoIterationSessionId: 'session-1',
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

  describe('sessionDataService', () => {
    it('returns existing RUNNING fixer session instead of creating a new one', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      const existing = await prisma.agentSession.create({
        data: {
          workspaceId: workspace.id,
          workflow: 'ci-fix',
          status: SessionStatus.RUNNING,
          model: 'sonnet',
          provider: 'CLAUDE',
        },
      });

      const acquired = await sessionDataService.acquireFixerSession({
        workspaceId: workspace.id,
        workflow: 'ci-fix',
        sessionName: 'CI Fixer',
        maxSessions: 3,
        provider: 'CLAUDE',
        providerProjectPath: '/tmp/worktree',
      });

      expect(acquired).toEqual({
        outcome: 'existing',
        sessionId: existing.id,
        status: SessionStatus.RUNNING,
      });
    });

    it('returns limit_reached when active session cap is already met', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      await prisma.agentSession.createMany({
        data: [
          {
            workspaceId: workspace.id,
            workflow: 'explore',
            status: SessionStatus.RUNNING,
            model: 'sonnet',
            provider: 'CLAUDE',
          },
          {
            workspaceId: workspace.id,
            workflow: 'feature',
            status: SessionStatus.IDLE,
            model: 'opus',
            provider: 'CLAUDE',
          },
        ],
      });

      const acquired = await sessionDataService.acquireFixerSession({
        workspaceId: workspace.id,
        workflow: 'ci-fix',
        sessionName: 'CI Fixer',
        maxSessions: 2,
        provider: 'CLAUDE',
        providerProjectPath: null,
      });

      expect(acquired).toEqual({ outcome: 'limit_reached' });
    });

    it('ignores completed and failed sessions when enforcing fixer session cap', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      await prisma.agentSession.createMany({
        data: [
          {
            workspaceId: workspace.id,
            workflow: 'explore',
            status: SessionStatus.COMPLETED,
            model: 'sonnet',
            provider: 'CLAUDE',
          },
          {
            workspaceId: workspace.id,
            workflow: 'feature',
            status: SessionStatus.FAILED,
            model: 'opus',
            provider: 'CLAUDE',
          },
        ],
      });

      const acquired = await sessionDataService.acquireFixerSession({
        workspaceId: workspace.id,
        workflow: 'ci-fix',
        sessionName: 'CI Fixer',
        maxSessions: 2,
        provider: 'CLAUDE',
        providerProjectPath: null,
      });

      expect(acquired.outcome).toBe('created');
    });

    it('creates fixer session and reuses recent model preference', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      await prisma.agentSession.create({
        data: {
          workspaceId: workspace.id,
          workflow: 'explore',
          model: 'opus',
          status: SessionStatus.COMPLETED,
          provider: 'CLAUDE',
        },
      });

      const acquired = await sessionDataService.acquireFixerSession({
        workspaceId: workspace.id,
        workflow: 'ci-fix',
        sessionName: 'CI Fixer',
        maxSessions: 5,
        provider: 'CLAUDE',
        providerProjectPath: '/tmp/worktree',
      });

      expect(acquired.outcome).toBe('created');
      if (acquired.outcome !== 'created') {
        throw new Error(`Expected created outcome, received ${acquired.outcome}`);
      }

      const created = await prisma.agentSession.findUniqueOrThrow({
        where: { id: acquired.sessionId },
      });
      expect(created.model).toBe('opus');
      expect(created.status).toBe(SessionStatus.IDLE);
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

      await terminalSessionService.clearPid(workspace.id, 'terminal-a');

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

      const withPid = await terminalSessionService.findWithPid();

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
    it('formats automatic error logs with structured context', async () => {
      const entry = await decisionLogService.createAutomatic('agent-1', 'OpenFile', 'error', {
        message: 'permission denied',
        code: 'EACCES',
      });

      expect(entry.agentId).toBe('agent-1');
      expect(entry.decision).toBe('Tool error: OpenFile');
      expect(entry.reasoning).toBe('Automatic tool error log');
      expect(entry.context).toContain('permission denied');
      expect(entry.context).toContain('EACCES');
    });

    it('lists recent logs scoped by agent id', async () => {
      await decisionLogService.createManual('agent-1', 'Decision A', 'Reason A');
      await decisionLogService.createManual('agent-2', 'Decision B', 'Reason B');
      await decisionLogService.createManual('agent-1', 'Decision C', 'Reason C');

      const agentOne = await decisionLogService.list({ agentId: 'agent-1', limit: 10 });
      const all = await decisionLogService.list({ limit: 10 });

      expect(agentOne).toHaveLength(2);
      expect(agentOne.every((entry) => entry.agentId === 'agent-1')).toBe(true);
      expect(all).toHaveLength(3);
    });
  });
});
