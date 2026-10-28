import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { createLifecycleTestSession } from '@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers';
import { userSettingsService } from '@/backend/services/settings';
import { SessionStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createDefaultApplicationDependencies } from './app-context';
import { clearWorkspaceInitOrchestratorStateForTests } from './orchestration/workspace-init.orchestrator';
import {
  SessionConfigService,
  SessionDomainService,
  sessionConfigService,
  sessionDispatchService,
  sessionDomainService,
} from './services/session';
import { WorkspaceCreationService } from './services/workspace';

// Only monitoring persistence is irrelevant to these producer/dispatcher contracts.
vi.mock('./orchestration/pr-monitoring.orchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./orchestration/pr-monitoring.orchestrator')>()),
  bindIssueMonitoringSession: vi.fn(),
}));

function createGraph(label: string) {
  const { services } = createDefaultApplicationDependencies();
  const delivered: { sessionId: string; text: string }[] = [];
  const attempts: string[] = [];
  const dispatcher = {
    delivered,
    attempts,
    configure: vi.fn(),
    setManualDispatchResume: vi.fn(),
    resetDispatchState: vi.fn(),
    tryDispatchNextMessage(sessionId: string) {
      this.attempts.push(sessionId);
      const message = sessionDomainService.dequeueNext(sessionId);
      if (message) {
        this.delivered.push({ sessionId, text: message.text });
      }
      return Promise.resolve();
    },
  };
  services.sessionDispatchService = dispatcher;
  return { services, delivered, attempts, label };
}

function setupInitialization(services: ReturnType<typeof createGraph>['services']) {
  const workspace = unsafeCoerce<
    NonNullable<Awaited<ReturnType<typeof services.workspaceDataService.findByIdWithProject>>>
  >({
    id: 'workspace-init',
    name: 'Workspace',
    worktreePath: '/tmp/existing-worktree',
    mode: 'MANUAL',
    project: { id: 'project', defaultBranch: 'main' },
    creationMetadata: { initialPrompt: 'Implement the issue' },
  });
  vi.spyOn(services.workspaceDataService, 'findByIdWithProject').mockResolvedValue(workspace);
  vi.spyOn(services.workspaceDataService, 'findById').mockResolvedValue(unsafeCoerce(workspace));
  vi.spyOn(services.worktreeLifecycleService, 'getInitMode').mockResolvedValue(false);
  vi.spyOn(services.factoryConfigService, 'readConfig').mockResolvedValue(null);
  vi.spyOn(
    services.runScriptConfigPersistenceService,
    'syncWorkspaceCommandsFromFactoryConfig'
  ).mockResolvedValue(unsafeCoerce({}));
  vi.spyOn(services.terminalService, 'getTerminalsForWorkspace').mockReturnValue([
    unsafeCoerce({ id: 'terminal' }),
  ]);
  vi.spyOn(services.startupScriptService, 'hasStartupScript').mockReturnValue(false);
  vi.spyOn(services.workspaceStateMachine, 'markReady').mockResolvedValue(workspace);
  vi.spyOn(services.sessionLifecycleService, 'startSession').mockResolvedValue(
    unsafeCoerce(undefined)
  );
  vi.spyOn(agentSessionAccessor, 'findByWorkspaceId').mockResolvedValue([
    createLifecycleTestSession({ id: 'session-init', status: SessionStatus.IDLE, model: 'sonnet' }),
  ]);
  vi.spyOn(services.workspaceStateMachine, 'startProvisioning').mockResolvedValue(workspace);
}

describe('application queue producer composition', () => {
  beforeEach(() => {
    clearWorkspaceInitOrchestratorStateForTests();
    vi.spyOn(sessionDispatchService, 'tryDispatchNextMessage').mockResolvedValue();
  });
  afterEach(() => {
    sessionDomainService.clearAllSessions();
    clearWorkspaceInitOrchestratorStateForTests();
    vi.restoreAllMocks();
  });

  it('dispatches eager initialization and READY retry through each supplied graph', async () => {
    const first = createGraph('first');
    const second = createGraph('second');
    setupInitialization(first.services);

    await first.services.initializeWorkspaceWorktree('workspace-init', {
      provisioningAlreadyStarted: true,
    });
    sessionDomainService.enqueue('session-init', {
      id: 'ready-retry',
      text: 'Queued while provisioning',
      timestamp: '2026-10-27T00:00:00.000Z',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    await second.services.retryQueuedDispatchAfterWorkspaceReady('workspace-init', 'session-init');

    expect(first.delivered).toEqual([{ sessionId: 'session-init', text: 'Implement the issue' }]);
    expect(first.attempts).toEqual(['session-init', 'session-init']);
    expect(second.attempts).toEqual(['session-init']);
    expect(second.delivered).toEqual([
      { sessionId: 'session-init', text: 'Queued while provisioning' },
    ]);
    expect(sessionDispatchService.tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it.each(['child', 'periodic'] as const)(
    'starts %s initialization with the owning graph dispatcher',
    async (source) => {
      const graph = createGraph(source);
      setupInitialization(graph.services);
      vi.spyOn(graph.services.projectManagementService, 'findById').mockResolvedValue(
        unsafeCoerce({ id: 'project', isArchived: false })
      );
      vi.spyOn(WorkspaceCreationService.prototype, 'create').mockResolvedValue(
        unsafeCoerce({ id: 'workspace-init' })
      );
      vi.spyOn(
        graph.services.sessionProviderResolverService,
        'resolveProviderForWorkspaceCreation'
      ).mockResolvedValue('CLAUDE');
      vi.spyOn(graph.services.sessionDataService, 'createAgentSession').mockResolvedValue(
        unsafeCoerce({ id: 'session-init' })
      );
      if (source === 'child') {
        await graph.services.createChildWorkspace({
          parentWorkspaceId: 'parent',
          projectId: 'project',
          name: 'Child',
        });
      } else {
        await graph.services.launchWorkspace({
          type: 'PERIODIC_TASK',
          projectId: 'project',
          name: 'Periodic',
          initialPrompt: 'Periodic task prompt',
          periodicTaskId: 'task',
        });
      }
      await vi.waitFor(() => {
        expect(graph.delivered).toEqual([
          { sessionId: 'session-init', text: 'Implement the issue' },
        ]);
        expect(graph.attempts).toEqual(['session-init', 'session-init']);
      });
      expect(sessionDispatchService.tryDispatchNextMessage).not.toHaveBeenCalled();
    }
  );

  it.each(['CHILD_TO_PARENT', 'PARENT_TO_CHILD'] as const)(
    'queues and delivers %s notifications through each supplied graph',
    async (direction) => {
      const first = createGraph('first');
      const second = createGraph('second');
      const { services } = first;
      vi.spyOn(services.workspaceDataService, 'findByIdWithProject').mockResolvedValue(
        unsafeCoerce({
          id: 'source',
          name: 'Source',
          project: { name: 'Project' },
        })
      );
      vi.spyOn(services.workspaceDataService, 'exists').mockResolvedValue(true);
      const notification = unsafeCoerce<
        Awaited<ReturnType<typeof services.workspaceNotificationService.notifyParent>>
      >({
        id: 'notification-graph',
        direction,
        sourceWorkspaceName: 'Source',
        message: 'Graph notification',
      });
      vi.spyOn(services.workspaceNotificationService, 'notifyParent').mockResolvedValue(
        notification
      );
      vi.spyOn(services.workspaceNotificationService, 'notifyChild').mockResolvedValue(
        notification
      );
      vi.spyOn(agentSessionAccessor, 'findByWorkspaceId').mockImplementation(async (id) => [
        createLifecycleTestSession({ id: `session-${id}`, status: SessionStatus.IDLE }),
      ]);
      for (const graph of [first, second]) {
        await expect(
          graph.services.deliverWorkspaceNotification({
            direction,
            targetWorkspaceId: graph.label,
            sourceWorkspace: { id: 'source', name: 'Source', projectName: 'Project' },
            message: 'Graph notification',
            buildUiEvent: ({ timestamp }) => ({
              type: 'child_workspace_update',
              childWorkspaceId: 'source',
              childWorkspaceName: 'Source',
              childProjectName: 'Project',
              text: 'Graph notification',
              timestamp,
            }),
          })
        ).resolves.toEqual({ delivered: true });
      }
      expect(first.delivered).toEqual([
        { sessionId: 'session-first', text: expect.stringContaining('Graph notification') },
      ]);
      expect(second.delivered).toEqual([
        { sessionId: 'session-second', text: expect.stringContaining('Graph notification') },
      ]);
      expect(sessionDomainService.peekNextMessage('session-first')).toBeUndefined();
      expect(sessionDomainService.peekNextMessage('session-second')).toBeUndefined();
      expect(sessionDispatchService.tryDispatchNextMessage).not.toHaveBeenCalled();
    }
  );
  it('loads through distinct config, domain, and dispatch graphs without singleton fallbacks', async () => {
    const forbidden = () => {
      throw new Error('Load crossed into the global graph');
    };
    vi.spyOn(sessionConfigService, 'getSessionConfigProjection').mockImplementation(forbidden);
    vi.spyOn(sessionDispatchService, 'tryDispatchNextMessage').mockImplementation(forbidden);
    for (const method of ['finishLoad', 'emitDelta', 'consumeInitialMessage', 'enqueue'] as const) {
      vi.spyOn(sessionDomainService, method).mockImplementation(forbidden);
    }
    vi.spyOn(userSettingsService, 'get').mockResolvedValue(
      unsafeCoerce({ cachedSlashCommands: null })
    );
    const graphs = ['first', 'second'].map((label) => {
      const { services } = createDefaultApplicationDependencies();
      const domain = new SessionDomainService();
      const configOptions = [
        {
          id: 'model',
          category: 'model',
          name: 'Model',
          type: 'select',
          currentValue: label,
          options: [{ value: label, name: label }],
        },
      ];
      services.sessionDomainService = domain;
      services.sessionConfigService = new SessionConfigService({
        repository: unsafeCoerce({ getSessionById: forbidden }),
        runtimeManager: unsafeCoerce({ getClient: () => ({ provider: 'CODEX', configOptions }) }),
        codexModelCatalogService: { getModels: forbidden },
        sessionDomainService: domain,
      });
      const projection = vi.spyOn(services.sessionConfigService, 'getSessionConfigProjection');
      const emitted = vi.spyOn(domain, 'emitDelta');
      const delivered: string[] = [];
      const dispatch = vi.fn((id: string) => {
        const message = domain.dequeueNext(id);
        if (message) {
          delivered.push(message.text);
        }
        return Promise.resolve();
      });
      services.sessionDispatchService = {
        configure: vi.fn(),
        setManualDispatchResume: vi.fn(),
        resetDispatchState: vi.fn(),
        tryDispatchNextMessage: dispatch,
      };
      domain.storeInitialMessage('shared-load', `Initial ${label}`);
      return { label, services, domain, projection, emitted, delivered, dispatch };
    });
    for (const graph of graphs) {
      await graph.services.sessionLoadService.completeLoad({
        status: 'ready',
        sessionId: 'shared-load',
        provider: 'CODEX',
        worktreePath: null,
      });
      expect(graph.projection).toHaveBeenCalledExactlyOnceWith('shared-load');
      expect(graph.emitted.mock.calls.map((call) => call[1])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'chat_capabilities',
            capabilities: expect.objectContaining({
              model: expect.objectContaining({ selected: graph.label }),
            }),
          }),
          expect.objectContaining({
            type: 'config_options_update',
            configOptions: expect.arrayContaining([
              expect.objectContaining({ currentValue: graph.label }),
            ]),
          }),
        ])
      );
      expect(graph.delivered).toEqual([`Initial ${graph.label}`]);
      expect(graph.dispatch).toHaveBeenCalledExactlyOnceWith('shared-load');
    }
    expect(graphs[0]?.domain).not.toBe(graphs[1]?.domain);
    expect(graphs[0]?.services.sessionConfigService).not.toBe(
      graphs[1]?.services.sessionConfigService
    );
  });
});
