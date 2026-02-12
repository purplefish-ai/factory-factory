import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CIStatus,
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

let workspaceAccessor: typeof import('./workspace.accessor').workspaceAccessor;
let projectAccessor: typeof import('./project.accessor').projectAccessor;
let claudeSessionAccessor: typeof import('./claude-session.accessor').claudeSessionAccessor;
let terminalSessionAccessor: typeof import('./terminal-session.accessor').terminalSessionAccessor;
let userSettingsAccessor: typeof import('./user-settings.accessor').userSettingsAccessor;
let decisionLogAccessor: typeof import('./decision-log.accessor').decisionLogAccessor;
let GitClientFactory: typeof import('@/backend/clients/git.client').GitClientFactory;

let counter = 0;
const tempRepoDirs = new Set<string>();

beforeAll(async () => {
  db = await createIntegrationDatabase();
  prisma = db.prisma;

  // biome-ignore lint: dynamic import is required after integration DB bootstrap.
  const accessorModule = await import('@/backend/resource_accessors');
  ({
    workspaceAccessor,
    projectAccessor,
    claudeSessionAccessor,
    terminalSessionAccessor,
    userSettingsAccessor,
    decisionLogAccessor,
  } = accessorModule);

  // biome-ignore lint: dynamic import is required after integration DB bootstrap.
  const gitClientModule = await import('@/backend/clients/git.client');
  ({ GitClientFactory } = gitClientModule);
});

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

describe('resource accessors integration', () => {
  describe('workspaceAccessor', () => {
    it('enforces compare-and-swap status transitions', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id, { status: WorkspaceStatus.NEW });

      const changed = await workspaceAccessor.transitionWithCas(workspace.id, WorkspaceStatus.NEW, {
        status: WorkspaceStatus.PROVISIONING,
      });
      const unchanged = await workspaceAccessor.transitionWithCas(
        workspace.id,
        WorkspaceStatus.NEW,
        {
          status: WorkspaceStatus.READY,
        }
      );

      const reloaded = await workspaceAccessor.findRawByIdOrThrow(workspace.id);

      expect(changed.count).toBe(1);
      expect(unchanged.count).toBe(0);
      expect(reloaded.status).toBe(WorkspaceStatus.PROVISIONING);
    });

    it('enforces compare-and-swap run script transitions', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id, {
        runScriptStatus: RunScriptStatus.IDLE,
      });

      const started = await workspaceAccessor.casRunScriptStatusUpdate(
        workspace.id,
        RunScriptStatus.IDLE,
        {
          runScriptStatus: RunScriptStatus.STARTING,
        }
      );

      const duplicate = await workspaceAccessor.casRunScriptStatusUpdate(
        workspace.id,
        RunScriptStatus.IDLE,
        {
          runScriptStatus: RunScriptStatus.RUNNING,
        }
      );

      const reloaded = await workspaceAccessor.findRawByIdOrThrow(workspace.id);
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

      const eligibleResult = await workspaceAccessor.startProvisioningRetryIfAllowed(
        eligible.id,
        3
      );
      const maxedResult = await workspaceAccessor.startProvisioningRetryIfAllowed(maxed.id, 3);

      const eligibleReloaded = await workspaceAccessor.findRawByIdOrThrow(eligible.id);
      const maxedReloaded = await workspaceAccessor.findRawByIdOrThrow(maxed.id);

      expect(eligibleResult.count).toBe(1);
      expect(maxedResult.count).toBe(0);
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

      const needingWorktree = await workspaceAccessor.findNeedingWorktree();
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

      const ratchetCandidates = await workspaceAccessor.findWithPRsForRatchet();

      expect(ratchetCandidates.map((workspace) => workspace.id)).toEqual([included.id]);
    });

    it('truncates init output when max size is exceeded', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      await workspaceAccessor.appendInitOutput(workspace.id, 'a'.repeat(80), 50);

      const reloaded = await workspaceAccessor.findRawByIdOrThrow(workspace.id);
      expect(reloaded.initOutput).toBeTruthy();
      expect((reloaded.initOutput || '').length).toBeLessThanOrEqual(50);
      expect(reloaded.initOutput?.startsWith('[...truncated...]\n')).toBe(true);
    });

    it('clears ratchet active session only when session id matches', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id, {
        ratchetActiveSessionId: 'session-1',
      });

      await workspaceAccessor.clearRatchetActiveSession(workspace.id, 'different-session');
      const unchanged = await workspaceAccessor.findRawByIdOrThrow(workspace.id);
      expect(unchanged.ratchetActiveSessionId).toBe('session-1');

      await workspaceAccessor.clearRatchetActiveSession(workspace.id, 'session-1');
      const cleared = await workspaceAccessor.findRawByIdOrThrow(workspace.id);
      expect(cleared.ratchetActiveSessionId).toBeNull();
    });

    it('throws when mutually exclusive status filters are passed', async () => {
      const project = await createProjectFixture();

      expect(() =>
        workspaceAccessor.findByProjectIdWithSessions(project.id, {
          status: WorkspaceStatus.READY,
          excludeStatuses: [WorkspaceStatus.NEW],
        })
      ).toThrow('Cannot specify both status and excludeStatuses filters');
    });
  });

  describe('projectAccessor', () => {
    it('auto-detects GitHub owner/repo from git remote during create', async () => {
      const repoPath = createGitRepository('git@github.com:purplefish-ai/factory-factory.git');

      const project = await projectAccessor.create(
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

    it('retries slug creation when a slug collision occurs', async () => {
      const repoPath = createGitRepository();

      const first = await projectAccessor.create(
        {
          repoPath,
        },
        {
          worktreeBaseDir: '/tmp/worktrees',
        }
      );

      const second = await projectAccessor.create(
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

      const valid = await projectAccessor.validateRepoPath(gitRepo);
      const invalid = await projectAccessor.validateRepoPath(nonGitDir);
      const missing = await projectAccessor.validateRepoPath('/path/that/does/not/exist');

      expect(valid.valid).toBe(true);
      expect(invalid.valid).toBe(false);
      expect(invalid.error).toContain('not a git repository');
      expect(missing.valid).toBe(false);
      expect(missing.error).toContain('does not exist');
    });

    it('evicts git client cache on project delete', async () => {
      const project = await createProjectFixture();
      const removeSpy = vi.spyOn(GitClientFactory, 'removeProject').mockImplementation(() => false);

      await projectAccessor.delete(project.id);

      expect(removeSpy).toHaveBeenCalledWith({
        repoPath: project.repoPath,
        worktreeBasePath: project.worktreeBasePath,
      });
    });
  });

  describe('claudeSessionAccessor', () => {
    it('returns existing RUNNING fixer session instead of creating a new one', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      const existing = await prisma.claudeSession.create({
        data: {
          workspaceId: workspace.id,
          workflow: 'ci-fix',
          status: SessionStatus.RUNNING,
          model: 'sonnet',
        },
      });

      const acquired = await claudeSessionAccessor.acquireFixerSession({
        workspaceId: workspace.id,
        workflow: 'ci-fix',
        sessionName: 'CI Fixer',
        maxSessions: 3,
        claudeProjectPath: '/tmp/worktree',
      });

      expect(acquired).toEqual({
        outcome: 'existing',
        sessionId: existing.id,
        status: SessionStatus.RUNNING,
      });
    });

    it('returns limit_reached when session cap is already met', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      await prisma.claudeSession.createMany({
        data: [
          {
            workspaceId: workspace.id,
            workflow: 'explore',
            status: SessionStatus.COMPLETED,
            model: 'sonnet',
          },
          {
            workspaceId: workspace.id,
            workflow: 'feature',
            status: SessionStatus.COMPLETED,
            model: 'opus',
          },
        ],
      });

      const acquired = await claudeSessionAccessor.acquireFixerSession({
        workspaceId: workspace.id,
        workflow: 'ci-fix',
        sessionName: 'CI Fixer',
        maxSessions: 2,
        claudeProjectPath: null,
      });

      expect(acquired).toEqual({ outcome: 'limit_reached' });
    });

    it('creates fixer session and reuses recent model preference', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      await prisma.claudeSession.create({
        data: {
          workspaceId: workspace.id,
          workflow: 'explore',
          model: 'opus',
          status: SessionStatus.COMPLETED,
        },
      });

      const acquired = await claudeSessionAccessor.acquireFixerSession({
        workspaceId: workspace.id,
        workflow: 'ci-fix',
        sessionName: 'CI Fixer',
        maxSessions: 5,
        claudeProjectPath: '/tmp/worktree',
      });

      expect(acquired.outcome).toBe('created');
      if (acquired.outcome !== 'created') {
        throw new Error(`Expected created outcome, received ${acquired.outcome}`);
      }

      const created = await prisma.claudeSession.findUniqueOrThrow({
        where: { id: acquired.sessionId },
      });
      expect(created.model).toBe('opus');
      expect(created.status).toBe(SessionStatus.IDLE);
    });
  });

  describe('terminalSessionAccessor', () => {
    it('clears pid for all matching terminal names', async () => {
      const project = await createProjectFixture();
      const workspace = await createWorkspaceFixture(project.id);

      await prisma.terminalSession.createMany({
        data: [
          { workspaceId: workspace.id, name: 'terminal-a', pid: 1001 },
          { workspaceId: workspace.id, name: 'terminal-a', pid: 2002 },
          { workspaceId: workspace.id, name: 'terminal-b', pid: 3003 },
        ],
      });

      await terminalSessionAccessor.clearPid('terminal-a');

      const all = await prisma.terminalSession.findMany({ orderBy: { name: 'asc' } });
      const target = all.filter((session) => session.name === 'terminal-a');
      const untouched = all.find((session) => session.name === 'terminal-b');

      expect(target.every((session) => session.pid === null)).toBe(true);
      expect(untouched?.pid).toBe(3003);
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

      const withPid = await terminalSessionAccessor.findWithPid();

      expect(withPid.map((session) => session.id)).toEqual([live.id]);
    });
  });

  describe('userSettingsAccessor', () => {
    it('creates defaults on first read', async () => {
      const settings = await userSettingsAccessor.get();

      expect(settings.userId).toBe('default');
      expect(settings.preferredIde).toBe('cursor');
      expect(settings.playSoundOnComplete).toBe(true);
    });

    it('persists workspace order by project id', async () => {
      const projectA = await createProjectFixture();
      const projectB = await createProjectFixture();

      await userSettingsAccessor.updateWorkspaceOrder(projectA.id, ['ws-3', 'ws-1']);
      await userSettingsAccessor.updateWorkspaceOrder(projectB.id, ['ws-9']);

      const orderA = await userSettingsAccessor.getWorkspaceOrder(projectA.id);
      const orderB = await userSettingsAccessor.getWorkspaceOrder(projectB.id);

      expect(orderA).toEqual(['ws-3', 'ws-1']);
      expect(orderB).toEqual(['ws-9']);
    });
  });

  describe('decisionLogAccessor', () => {
    it('formats automatic error logs with structured context', async () => {
      const entry = await decisionLogAccessor.createAutomatic('agent-1', 'OpenFile', 'error', {
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
      await decisionLogAccessor.createManual('agent-1', 'Decision A', 'Reason A');
      await decisionLogAccessor.createManual('agent-2', 'Decision B', 'Reason B');
      await decisionLogAccessor.createManual('agent-1', 'Decision C', 'Reason C');

      const agentOne = await decisionLogAccessor.list({ agentId: 'agent-1', limit: 10 });
      const all = await decisionLogAccessor.list({ limit: 10 });

      expect(agentOne).toHaveLength(2);
      expect(agentOne.every((entry) => entry.agentId === 'agent-1')).toBe(true);
      expect(all).toHaveLength(3);
    });
  });
});
