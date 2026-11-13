import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

let db: IntegrationDatabase;
let other: { id: string };
let domain: typeof import('@/backend/services/session/service/store/session-domain.service').sessionDomainService;
let cleanup: { db?: IntegrationDatabase; domain?: typeof domain } = {};
beforeEach(async () => {
  cleanup = {};
  db = await createIntegrationDatabase();
  cleanup.db = db;
  const project = await db.prisma.project.create({
    data: {
      name: 'Cleanup fixture',
      slug: crypto.randomUUID(),
      repoPath: db.tempDir,
      worktreeBasePath: db.tempDir,
    },
  });
  const workspace = await db.prisma.workspace.create({
    data: {
      name: 'Cleanup fixture',
      projectId: project.id,
      status: 'READY',
      worktreePath: db.tempDir,
    },
  });
  other = await db.prisma.agentSession.create({
    data: {
      workspaceId: workspace.id,
      workflow: 'ratchet',
      provider: 'CLAUDE',
      model: 'sonnet',
      status: 'IDLE',
    },
  });
  ({ sessionDomainService: domain } = await vi.importActual<
    typeof import('@/backend/services/session/service/store/session-domain.service')
  >('@/backend/services/session/service/store/session-domain.service'));
  cleanup.domain = domain;
});
afterEach(async () => {
  try {
    cleanup.domain?.clearAllSessions();
  } finally {
    vi.restoreAllMocks();
    if (cleanup.db) {
      await destroyIntegrationDatabase(cleanup.db);
    }
  }
});

it.each([
  ['deleted', 1],
  ['deleted', 0],
  ['persistence-failed', 1],
  ['deletion-failed', 1],
] as const)(
  'stop cleanup keeps transient store lifetime after %s with %s viewers',
  async (outcome, viewers) => {
    const { SessionRepository } = await vi.importActual<
      typeof import('@/backend/services/session/service/data/session.repository')
    >('@/backend/services/session/service/data/session.repository');
    const { SessionWorkflowFinalizer } = await vi.importActual<
      typeof import('@/backend/services/session/service/lifecycle/session-workflow-finalizer')
    >('@/backend/services/session/service/lifecycle/session-workflow-finalizer');
    const { SessionTerminationCoordinator } = await vi.importActual<
      typeof import('@/backend/services/session/service/lifecycle/session-termination.coordinator')
    >('@/backend/services/session/service/lifecycle/session-termination.coordinator');
    const { createTerminationHarness } = await vi.importActual<
      typeof import('@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers')
    >('@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers');
    const { SessionStoreRegistry } = await vi.importActual<
      typeof import('@/backend/services/session/service/store/session-store-registry')
    >('@/backend/services/session/service/store/session-store-registry');
    const { sessionEventBus } = await vi.importActual<
      typeof import('@/backend/services/session/service/session-event-bus')
    >('@/backend/services/session/service/session-event-bus');
    const stores: Array<{
      registry: InstanceType<typeof SessionStoreRegistry>;
      store: ReturnType<InstanceType<typeof SessionStoreRegistry>['getOrCreate']>;
    }> = [];
    const lookup = SessionStoreRegistry.prototype.getOrCreate;
    vi.spyOn(SessionStoreRegistry.prototype, 'getOrCreate').mockImplementation(function (
      this: InstanceType<typeof SessionStoreRegistry>,
      id
    ) {
      const store = lookup.call(this, id);
      if (id === other.id) {
        stores.push({ registry: this, store });
      }
      return store;
    });
    domain.injectCommittedUserMessage(other.id, 'Archive this transient conversation');
    const repository = new SessionRepository();
    const deletion = repository.deleteSession.bind(repository);
    let deleted = false;
    vi.spyOn(repository, 'deleteSession').mockImplementation(async (id) => {
      if (outcome === 'deletion-failed') {
        throw new Error('Deletion unavailable');
      }
      const result = await deletion(id);
      deleted = true;
      return result;
    });
    const publishedAfterDeletion = vi.fn();
    vi.spyOn(sessionEventBus, 'publishToSession').mockImplementation((id, payload) => {
      if (id === other.id && deleted) {
        publishedAfterDeletion(payload);
      }
    });
    sessionEventBus.registerViewerCountProvider(() => viewers);
    const base = createTerminationHarness();
    const persist = vi.fn(() =>
      outcome === 'persistence-failed'
        ? Promise.reject(new Error('Archive unavailable'))
        : Promise.resolve()
    );
    const finalizer = new SessionWorkflowFinalizer({
      repository,
      workspaceLookup: {
        findById: (id) => db.prisma.workspace.findUnique({ where: { id } }),
      },
      sessionDomainService: domain,
      closedSessionPersistenceService: { persistClosedSession: persist },
      lifecycleEventService: { hydrate: async () => undefined },
      hydrateProviderHistory: async () => undefined,
      runtimeManager: {
        isSessionRunning: () => false,
        hasObservedEmptyProviderSession: () => false,
      },
      countViewers: (id) => sessionEventBus.countViewers(id),
    });
    const coordinator = new SessionTerminationCoordinator({
      ...base,
      repository,
      sessionDomainService: domain,
      workflowFinalizer: finalizer,
      getRuntimeSnapshot: (id) => domain.getRuntimeSnapshot(id),
    });
    try {
      await coordinator.stopSession(other.id, { recordLifecycleEvent: false });
      expect(persist).toHaveBeenCalledOnce();
      expect(await db.prisma.agentSession.findUnique({ where: { id: other.id } })).toEqual(
        outcome === 'deleted' ? null : expect.objectContaining({ id: other.id })
      );
      expect(stores.some(({ registry, store }) => registry.isCurrentStore(other.id, store))).toBe(
        outcome !== 'deleted'
      );
      expect(publishedAfterDeletion).not.toHaveBeenCalled();
      expect(base.lifecycleGate.isStopReserved(other.id)).toBe(false);
    } finally {
      sessionEventBus.registerViewerCountProvider(null);
    }
  }
);
