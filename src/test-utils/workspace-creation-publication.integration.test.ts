import { EventEmitter } from 'node:events';
import { QueryClient } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatchBackgroundAction } from '@/backend/orchestration/background-action-dispatch.orchestrator';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
} from '@/backend/orchestration/event-collector.orchestrator';
import { launchWorkspace } from '@/backend/orchestration/workspace-launch.orchestrator';
import { jobRunner } from '@/backend/services/job-runner.service';
import { createLogger } from '@/backend/services/logger.service';
import { PeriodicTaskService } from '@/backend/services/periodic-task';
import { sessionDataService } from '@/backend/services/session';
import {
  SNAPSHOT_CHANGED,
  WORKSPACE_CREATED,
  type SnapshotChangedEvent,
  WorkspaceCreationService,
  WorkspaceSnapshotStore,
  workspaceStateMachine,
} from '@/backend/services/workspace';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { groupWorkspacesForSidebar } from '@/client/components/workspace-sidebar-grouping';
import {
  getProjectWorkspaceCacheReconciler,
  type ProjectWorkspaceCache,
} from '@/client/lib/workspace-cache-reconciler';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { deriveWorkspaceFlowState } from '@/shared/workspace-flow-state';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing test database');
    }
    return state.prisma;
  },
}));
const logger = createLogger('workspace-creation-publication-test');
let db: IntegrationDatabase;
let service: PeriodicTaskService;
let cleanup: (() => void) | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function collect() {
  const store = new WorkspaceSnapshotStore();
  store.configure({
    deriveFlowState: (input) =>
      deriveWorkspaceFlowState({
        ...input,
        prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
      }),
    deriveSidebarStatus: deriveWorkspaceSidebarStatus,
  });
  const collector = createEventCollectorOrchestrator(
    unsafeCoerce<EventCollectorDependencies>({
      createLogger: () => logger,
      prSnapshotService: new EventEmitter(),
      workspaceActivityService: new EventEmitter(),
      workspaceStateMachine,
      ratchetService: new EventEmitter(),
      runScriptStateMachine: new EventEmitter(),
      sessionDomainService: new EventEmitter(),
      workspaceDataService: { subscribeAcceptedBranch: () => vi.fn() },
      workspaceSnapshotStore: store,
    })
  );
  const changes: SnapshotChangedEvent[] = [];
  store.on(SNAPSHOT_CHANGED, (event: SnapshotChangedEvent) => changes.push(structuredClone(event)));
  collector.start();
  cleanup = () => {
    collector.stop();
    store.clear();
  };
  return { store, changes, collector };
}

beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
}, 30_000);
afterEach(async () => {
  await service?.stop();
  cleanup?.();
  cleanup = undefined;
  await db.prisma.workspace.deleteMany();
  await db.prisma.periodicTask.deleteMany();
});
afterAll(async () => destroyIntegrationDatabase(db));

describe('committed workspace creation publication', () => {
  it('isolates a throwing subscriber and delivers to later subscribers after persistence', async () => {
    const broken = () => {
      throw new Error('Subscriber failed');
    };
    workspaceStateMachine.on(WORKSPACE_CREATED, broken);
    const { store, changes } = collect();
    const delivered: string[] = [];
    const observe = (event: { workspaceId: string }) => delivered.push(event.workspaceId);
    workspaceStateMachine.once(WORKSPACE_CREATED, observe);
    try {
      const creation = new WorkspaceCreationService({ logger });
      const first = await creation.create({ type: 'MANUAL', projectId: 'project', name: 'First' });
      const second = await new WorkspaceCreationService({ logger }).create({
        type: 'MANUAL',
        projectId: 'project',
        name: 'Second',
      });
      expect(await db.prisma.workspace.count()).toBe(2);
      expect(store.getByWorkspaceId(first.id)?.name).toBe('First');
      expect(store.getByWorkspaceId(second.id)?.name).toBe('Second');
      expect(changes).toHaveLength(2);
      expect(delivered).toEqual([first.id]);
    } finally {
      workspaceStateMachine.off(WORKSPACE_CREATED, broken);
      workspaceStateMachine.off(WORKSPACE_CREATED, observe);
    }
  });

  it.each(['NEW', 'PROVISIONING', 'READY', 'FAILED'] as const)(
    'preserves existing %s state and DB provenance when creation is replayed',
    async (status) => {
      const { store, changes } = collect();
      const created = await new WorkspaceCreationService({ logger }).create({
        type: 'MANUAL',
        projectId: 'project',
        name: 'Original',
        branchName: 'original',
      });
      if (status !== 'NEW') {
        await workspaceStateMachine.startProvisioning(created.id);
        if (status !== 'PROVISIONING') {
          await workspaceStateMachine.transition(created.id, status);
        }
      }
      const newerAt = Date.now() + 60_000;
      store.upsert(
        created.id,
        {
          name: 'New name',
          nameUpdatedAt: newerAt,
          branchName: 'new-branch',
          branchUpdatedAt: newerAt,
        },
        'newer-observation'
      );
      const before = structuredClone(store.getByWorkspaceId(created.id));
      expect(before).toMatchObject({ status, name: 'New name', branchName: 'new-branch' });
      const count = changes.length;
      workspaceStateMachine.publishCreated(created);
      expect(store.getByWorkspaceId(created.id)).toEqual(before);
      expect(changes).toHaveLength(count);
      // Replay must not move either DB provenance fence.
      store.upsert(
        created.id,
        {
          name: 'Stale',
          nameUpdatedAt: newerAt - 1,
          branchName: 'stale',
          branchUpdatedAt: newerAt - 1,
        },
        'stale-observation'
      );
      expect(store.getByWorkspaceId(created.id)).toEqual(before);
    }
  );

  it('never resurrects a removed workspace even with a later creation observation', async () => {
    const { store, changes } = collect();
    const created = await new WorkspaceCreationService({ logger }).create({
      type: 'MANUAL',
      projectId: 'project',
      name: 'Removed',
    });
    store.remove(created.id, 1);
    workspaceStateMachine.publishCreated(created);
    expect(store.getByWorkspaceId(created.id)).toBeUndefined();
    expect(changes).toHaveLength(1);
  });

  it.each(['ARCHIVING', 'ARCHIVED'] as const)(
    'rejects %s creation input and tombstones for unseen workspaces',
    async (status) => {
      const { store, changes, collector } = collect();
      collector.stop();
      const created = await new WorkspaceCreationService({ logger }).create({
        type: 'MANUAL',
        projectId: 'project',
        name: 'Unseen',
      });
      expect(changes).toEqual([]);
      collector.start();
      workspaceStateMachine.publishCreated({ ...created, status });
      expect(store.getByWorkspaceId(created.id)).toBeUndefined();
      store.remove(created.id, 1);
      workspaceStateMachine.publishCreated(created);
      expect(store.getByWorkspaceId(created.id)).toBeUndefined();
      expect(changes).toEqual([]);
    }
  );

  it.each(['success', 'failure'] as const)(
    'publishes NEW into Working before required session setup settles with %s',
    async (outcome) => {
      const { store, changes } = collect();
      const creation = new WorkspaceCreationService({ logger });
      const sessionStarted = deferred<void>();
      const sessionGate = deferred<void>();
      const initializeWorktree = vi.fn(() => Promise.resolve());
      service = new PeriodicTaskService(logger);
      service.configure({
        status: { getWorkspaceStatus: () => Promise.resolve(null) },
        timerDispatch: {
          dispatchTimerEvent: (event) =>
            dispatchBackgroundAction(
              { target: 'new_workspace', event },
              {
                launchWorkspace: (source) =>
                  launchWorkspace(source, {
                    createWorkspace: (input) => creation.create(input),
                    createDefaultSession: async (input) => {
                      sessionStarted.resolve();
                      await sessionGate.promise;
                      return sessionDataService.createAgentSession(input);
                    },
                    initializeWorktree,
                    getMaxSessionsPerWorkspace: () => {
                      throw new Error('Unexpected capacity gate');
                    },
                    resolveProvider: () => {
                      throw new Error('Unexpected provider resolution');
                    },
                    checkCliHealth: () => {
                      throw new Error('Unexpected CLI preflight');
                    },
                    logger,
                  }),
              }
            ),
        },
      });
      const task = await service.create({
        projectId: 'project',
        name: 'Daily cleanup',
        prompt: 'Test instructions',
        cadence: 'DAILY',
      });
      service.start();
      await sessionStarted.promise;
      const finish = async () => {
        if (outcome === 'success') {
          sessionGate.resolve();
        } else {
          sessionGate.reject(new Error('Session setup failed'));
        }
        await jobRunner.waitForCurrentRun('periodic-task-poll');
        await service.stop();
      };
      try {
        const [workspace] = await db.prisma.workspace.findMany();
        expect(workspace).toBeDefined();
        expect(changes).toHaveLength(1);
        const published = changes[0]!;
        expect(published.entry).toMatchObject({
          workspaceId: workspace!.id,
          projectId: 'project',
          name: workspace!.name,
          status: 'NEW',
          creationSource: 'PERIODIC_TASK',
          createdAt: workspace!.createdAt.toISOString(),
          branchName: workspace!.branchName,
          worktreePath: null,
          kanbanColumn: 'WORKING',
          source: 'event:workspace_created',
        });
        expect(published.entry.summaryVersion).toBeUndefined();
        store.upsert(
          workspace!.id,
          {
            name: 'Stale name',
            nameUpdatedAt: workspace!.updatedAt.getTime() - 1,
            branchName: 'stale-branch',
            branchUpdatedAt: workspace!.updatedAt.getTime() - 1,
          },
          'stale-db-row'
        );
        expect(store.getByWorkspaceId(workspace!.id)).toEqual(published.entry);
        expect(initializeWorktree).not.toHaveBeenCalled();
        expect(await service.listExecutions(task.id)).toEqual([
          expect.objectContaining({ status: 'RUNNING', workspaceId: null }),
        ]);
        const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
        try {
          const cache = getProjectWorkspaceCacheReconciler(client, 'project');
          const connection = cache.beginConnection();
          cache.apply(connection, { type: 'snapshot_full', projectId: 'project', entries: [] });
          cache.apply(connection, {
            type: 'snapshot_changed',
            workspaceId: published.workspaceId,
            entry: published.entry,
          });
          const rows = client.getQueryData<ProjectWorkspaceCache>(cache.queryKey)?.workspaces ?? [];
          expect(rows).toHaveLength(1);
          expect(groupWorkspacesForSidebar(rows).working.map((row) => row.id)).toEqual([
            workspace!.id,
          ]);
        } finally {
          client.clear();
        }
      } finally {
        await finish();
      }
      const [workspace] = await db.prisma.workspace.findMany();
      expect(store.getByWorkspaceId(workspace!.id)?.status).toBe('NEW');
      expect(await service.listExecutions(task.id)).toEqual([
        expect.objectContaining(
          outcome === 'success'
            ? { status: 'RUNNING', workspaceId: workspace!.id }
            : {
                status: 'FAILED',
                workspaceId: null,
                errorMessage: 'Session setup failed',
                completedAt: expect.any(Date),
              }
        ),
      ]);
      expect(initializeWorktree).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
      expect(await db.prisma.agentSession.count()).toBe(outcome === 'success' ? 1 : 0);
      expect(changes).toHaveLength(1);
    }
  );
});
