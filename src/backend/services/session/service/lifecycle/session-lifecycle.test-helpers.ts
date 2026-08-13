import { type Mock, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type {
  SessionLifecycleMessageQueueBridge,
  SessionLifecycleWorkspaceBridge,
} from '@/backend/services/session/service/bridges';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { ChatMessage } from '@/shared/acp-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { SessionStatus, WorkspaceStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { AcpEventProcessor } from './acp-event-processor';
import type { SessionConfigService } from './session.config.service';
import { SessionLifecycleService } from './session.lifecycle.service';
import type { SessionRepository } from './session.repository';
import type { SessionLifecycleEventService } from './session-lifecycle-event.service';

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export type LifecycleTestWorkspace = NonNullable<
  Awaited<ReturnType<SessionRepository['getWorkspaceById']>>
>;

export type LifecycleHarnessOverrides = {
  session?: Partial<AgentSessionRecord>;
  workspace?: Partial<LifecycleTestWorkspace>;
  sessions?: AgentSessionRecord[];
  getSessionById?: SessionRepository['getSessionById'];
  getSessionsByWorkspaceId?: SessionRepository['getSessionsByWorkspaceId'];
  getOrCreateClient?: AcpRuntimeManager['getOrCreateClient'];
  enqueue?: SessionDomainService['enqueue'];
  transcript?: ChatMessage[];
  historyHydrationSource?: 'jsonl' | 'acp_fallback' | 'none';
  tryDispatchNextMessage?: SessionLifecycleMessageQueueBridge['tryDispatchNextMessage'];
  pendingNotificationCount?: number;
  useRealNotificationDelivery?: boolean;
  provider?: AgentSessionRecord['provider'];
  providerSessionId?: string | null;
  providerProcessPid?: number | null;
  worktreePath?: string | null;
};

type MockedPick<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: never[]) => unknown ? Mock<T[P]> : T[P];
};

export type LifecycleHarness = {
  service: SessionLifecycleService;
  repository: MockedPick<
    SessionRepository,
    | 'getSessionById'
    | 'getSessionsByWorkspaceId'
    | 'getWorkspaceById'
    | 'getProjectById'
    | 'markWorkspaceHasHadSessions'
    | 'updateSession'
    | 'updateSessionIfStatus'
  >;
  runtimeManager: MockedPick<
    AcpRuntimeManager,
    | 'isStopInProgress'
    | 'isSessionRunning'
    | 'isBrowseOnlySession'
    | 'isSessionWorking'
    | 'getClient'
    | 'getBrowseClient'
    | 'getPendingClient'
    | 'getSubagentBrowseCapability'
    | 'getOrCreateClient'
    | 'stopClient'
    | 'beginShutdown'
    | 'stopAllClients'
  >;
  sessionDomainService: MockedPick<
    SessionDomainService,
    | 'appendClaudeEvent'
    | 'emitDelta'
    | 'hasQueuedMessage'
    | 'enqueue'
    | 'getTranscriptSnapshot'
    | 'getHistoryHydrationSource'
    | 'setRuntimeSnapshot'
    | 'isHistoryHydrated'
    | 'getRuntimeSnapshot'
    | 'clearQueuedWork'
    | 'clearSession'
    | 'markProcessExit'
  >;
  acpEventProcessor: MockedPick<
    AcpEventProcessor,
    | 'createRuntimeEventHandler'
    | 'registerSessionContext'
    | 'setReplaySuppression'
    | 'clearSessionState'
    | 'clearStreamingState'
    | 'clearReplaySuppression'
    | 'finalizeOrphanedToolCalls'
    | 'clearSessionContext'
    | 'getWorkspaceId'
  >;
  sessionConfigService: MockedPick<
    SessionConfigService,
    | 'applyConfiguredReasoningEffort'
    | 'applyStartupModePreset'
    | 'applyConfiguredPermissionPreset'
    | 'persistAcpConfigSnapshot'
    | 'buildAcpChatBarCapabilities'
  >;
  lifecycleEventService: MockedPick<SessionLifecycleEventService, 'record' | 'hydrate'>;
  notificationService: { cancelPendingRequests: Mock<(sessionId: string) => void> };
  workspaceBridge: MockedPick<
    SessionLifecycleWorkspaceBridge,
    'markSessionRunning' | 'markSessionIdle' | 'recordRatchetSessionEnd' | 'resetPRDiscoveryBackoff'
  >;
  messageQueueBridge: MockedPick<SessionLifecycleMessageQueueBridge, 'tryDispatchNextMessage'>;
  session: AgentSessionRecord;
  workspace: LifecycleTestWorkspace;
  handle: AcpProcessHandle;
  sendSessionMessage: Mock<(sessionId: string, content: string) => Promise<void>>;
  deliverPendingChildNotifications: Mock<
    (sessionId: string, workspaceId: string) => Promise<number>
  >;
  tryDispatchNextMessage: Mock<SessionLifecycleMessageQueueBridge['tryDispatchNextMessage']>;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function createLifecycleTestSession(
  overrides: Partial<AgentSessionRecord> = {}
): AgentSessionRecord {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    name: null,
    workflow: 'code',
    model: 'claude-sonnet',
    status: SessionStatus.IDLE,
    provider: 'CLAUDE',
    providerSessionId: null,
    providerProjectPath: null,
    providerProcessPid: 4242,
    providerMetadata: null,
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
    updatedAt: new Date('2026-07-15T00:00:00.000Z'),
    ...overrides,
  };
}

export function createLifecycleTestWorkspace(
  overrides: Partial<LifecycleTestWorkspace> = {}
): LifecycleTestWorkspace {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    description: null,
    projectId: 'project-1',
    status: WorkspaceStatus.READY,
    worktreePath: '/tmp/workspace',
    branchName: 'feature/test',
    isAutoGeneratedBranch: false,
    creationSource: 'MANUAL',
    creationMetadata: null,
    initErrorMessage: null,
    initOutput: null,
    initStartedAt: null,
    initCompletedAt: null,
    initScriptPid: null,
    initRetryCount: 0,
    githubIssueNumber: null,
    githubIssueUrl: null,
    linearIssueId: null,
    linearIssueIdentifier: null,
    linearIssueUrl: null,
    defaultSessionProvider: 'WORKSPACE_DEFAULT',
    ratchetSessionProvider: 'WORKSPACE_DEFAULT',
    periodicTaskId: null,
    parentWorkspaceId: null,
    hasHadSessions: false,
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
    updatedAt: new Date('2026-07-15T00:00:00.000Z'),
    runScriptPort: null,
    ...overrides,
  };
}

export function createLifecycleHarness(
  overrides: LifecycleHarnessOverrides = {}
): LifecycleHarness {
  const session = createLifecycleTestSession({
    provider: overrides.provider ?? 'CLAUDE',
    providerSessionId: overrides.providerSessionId ?? null,
    providerProcessPid: overrides.providerProcessPid ?? 4242,
    ...overrides.session,
  });
  const workspace = createLifecycleTestWorkspace({
    worktreePath: overrides.worktreePath === undefined ? '/tmp/workspace' : overrides.worktreePath,
    ...overrides.workspace,
  });
  const handle = {
    provider: session.provider,
    providerSessionId: session.providerSessionId ?? 'provider-session-1',
    configOptions: [],
    isPromptInFlight: false,
    getSubagentBrowseCapability: vi.fn(() => ({
      version: 1 as const,
      list: true as const,
      read: true as const,
      notifications: true as const,
    })),
  } as unknown as AcpProcessHandle;
  const repository = {
    getSessionById: vi.fn<SessionRepository['getSessionById']>(
      overrides.getSessionById ?? (async () => session)
    ),
    getSessionsByWorkspaceId: vi.fn<SessionRepository['getSessionsByWorkspaceId']>(
      overrides.getSessionsByWorkspaceId ??
        (async () => [
          createLifecycleTestSession({ id: 'session-running', status: SessionStatus.RUNNING }),
          createLifecycleTestSession({
            id: 'session-runtime-only',
            status: SessionStatus.COMPLETED,
          }),
          createLifecycleTestSession({ id: 'session-browse-only', status: SessionStatus.IDLE }),
          createLifecycleTestSession({ id: 'session-idle', status: SessionStatus.IDLE }),
        ])
    ),
    getWorkspaceById: vi.fn<SessionRepository['getWorkspaceById']>(async () => workspace),
    getProjectById: vi.fn<SessionRepository['getProjectById']>(async () => null),
    markWorkspaceHasHadSessions: vi.fn<SessionRepository['markWorkspaceHasHadSessions']>(
      async () => undefined
    ),
    updateSession: vi.fn<SessionRepository['updateSession']>(async () => session),
    updateSessionIfStatus: vi.fn<SessionRepository['updateSessionIfStatus']>(async () => 0),
  } satisfies Pick<
    SessionRepository,
    | 'getSessionById'
    | 'getSessionsByWorkspaceId'
    | 'getWorkspaceById'
    | 'getProjectById'
    | 'markWorkspaceHasHadSessions'
    | 'updateSession'
    | 'updateSessionIfStatus'
  >;
  const runtimeManager = {
    isStopInProgress: vi.fn(() => false),
    isSessionRunning: vi.fn((sessionId: string) => sessionId === 'session-runtime-only'),
    isBrowseOnlySession: vi.fn((sessionId: string) => sessionId === 'session-browse-only'),
    isSessionWorking: vi.fn(() => false),
    getClient: vi.fn(() => undefined),
    getBrowseClient: vi.fn(() => undefined),
    getPendingClient: vi.fn(() => undefined),
    getSubagentBrowseCapability: vi.fn<AcpRuntimeManager['getSubagentBrowseCapability']>(
      () => null
    ),
    getOrCreateClient: vi.fn<AcpRuntimeManager['getOrCreateClient']>(
      overrides.getOrCreateClient ?? (async () => handle)
    ),
    stopClient: vi.fn(async () => undefined),
    beginShutdown: vi.fn(() => []),
    stopAllClients: vi.fn(async () => undefined),
  } satisfies Pick<
    AcpRuntimeManager,
    | 'isStopInProgress'
    | 'isSessionRunning'
    | 'isBrowseOnlySession'
    | 'isSessionWorking'
    | 'getClient'
    | 'getBrowseClient'
    | 'getPendingClient'
    | 'getSubagentBrowseCapability'
    | 'getOrCreateClient'
    | 'stopClient'
    | 'beginShutdown'
    | 'stopAllClients'
  >;
  const sessionDomainService = {
    appendClaudeEvent: vi.fn((_sessionId: string, _message: unknown) => 1),
    emitDelta: vi.fn(),
    hasQueuedMessage: vi.fn((_sessionId: string, _messageId: string) => false),
    enqueue: vi.fn<SessionDomainService['enqueue']>(overrides.enqueue ?? (() => ({ position: 0 }))),
    getTranscriptSnapshot: vi.fn(() => overrides.transcript ?? []),
    getHistoryHydrationSource: vi.fn(() => overrides.historyHydrationSource ?? 'none'),
    setRuntimeSnapshot: vi.fn(),
    isHistoryHydrated: vi.fn(() => false),
    getRuntimeSnapshot: vi.fn<SessionDomainService['getRuntimeSnapshot']>(() => ({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-07-15T00:00:00.000Z',
    })),
    clearQueuedWork: vi.fn(),
    clearSession: vi.fn(),
    markProcessExit: vi.fn(),
  } satisfies Pick<
    SessionDomainService,
    | 'appendClaudeEvent'
    | 'emitDelta'
    | 'hasQueuedMessage'
    | 'enqueue'
    | 'getTranscriptSnapshot'
    | 'getHistoryHydrationSource'
    | 'setRuntimeSnapshot'
    | 'isHistoryHydrated'
    | 'getRuntimeSnapshot'
    | 'clearQueuedWork'
    | 'clearSession'
    | 'markProcessExit'
  >;
  const sessionConfigService = {
    applyConfiguredReasoningEffort: vi.fn(async () => undefined),
    applyStartupModePreset: vi.fn(async () => undefined),
    applyConfiguredPermissionPreset: vi.fn(async () => undefined),
    persistAcpConfigSnapshot: vi.fn(async () => undefined),
    buildAcpChatBarCapabilities: vi.fn<SessionConfigService['buildAcpChatBarCapabilities']>(
      () => EMPTY_CHAT_BAR_CAPABILITIES
    ),
  } satisfies Pick<
    SessionConfigService,
    | 'applyConfiguredReasoningEffort'
    | 'applyStartupModePreset'
    | 'applyConfiguredPermissionPreset'
    | 'persistAcpConfigSnapshot'
    | 'buildAcpChatBarCapabilities'
  >;
  const acpEventProcessor = {
    createRuntimeEventHandler: vi.fn(() => ({})),
    registerSessionContext: vi.fn(),
    setReplaySuppression: vi.fn(),
    clearSessionState: vi.fn(),
    clearStreamingState: vi.fn(),
    clearReplaySuppression: vi.fn(),
    finalizeOrphanedToolCalls: vi.fn(),
    clearSessionContext: vi.fn(),
    getWorkspaceId: vi.fn(() => undefined),
  } satisfies Pick<
    AcpEventProcessor,
    | 'createRuntimeEventHandler'
    | 'registerSessionContext'
    | 'setReplaySuppression'
    | 'clearSessionState'
    | 'clearStreamingState'
    | 'clearReplaySuppression'
    | 'finalizeOrphanedToolCalls'
    | 'clearSessionContext'
    | 'getWorkspaceId'
  >;
  const lifecycleEventService = {
    record: vi.fn<SessionLifecycleEventService['record']>(async () => null),
    hydrate: vi.fn(async () => undefined),
  } satisfies Pick<SessionLifecycleEventService, 'record' | 'hydrate'>;
  const notificationService = {
    cancelPendingRequests: vi.fn(),
  };
  const workspaceBridge = {
    markSessionRunning: vi.fn(() => 0),
    markSessionIdle: vi.fn(),
    recordRatchetSessionEnd: vi.fn(async () => undefined),
    resetPRDiscoveryBackoff: vi.fn(async () => true),
  } satisfies SessionLifecycleWorkspaceBridge;
  const messageQueueBridge = {
    tryDispatchNextMessage: vi.fn<SessionLifecycleMessageQueueBridge['tryDispatchNextMessage']>(
      overrides.tryDispatchNextMessage ?? (async () => undefined)
    ),
  } satisfies SessionLifecycleMessageQueueBridge;
  const sendSessionMessage = vi.fn(async () => undefined);
  const service = new SessionLifecycleService(
    unsafeCoerce({
      repository,
      promptBuilder: {
        shouldInjectBranchRename: vi.fn(() => false),
        buildSystemPrompt: vi.fn(() => ({
          workflowPrompt: undefined,
          systemPrompt: 'system prompt',
          injectedBranchRename: false,
        })),
      },
      runtimeManager,
      sessionDomainService,
      sessionPermissionService: notificationService,
      sessionConfigService,
      acpEventProcessor,
      promptTurnCompletionService: { clearSession: vi.fn(), clearAll: vi.fn() },
      retryService: {
        run: vi.fn(async (operation: () => Promise<unknown>) => await operation()),
      },
      sendSessionMessage,
      lifecycleEventService,
    })
  );
  service.configure({ workspace: workspaceBridge, messageQueue: messageQueueBridge });
  const deliverPendingChildNotifications = vi.fn(
    async () => overrides.pendingNotificationCount ?? 0
  );
  if (!overrides.useRealNotificationDelivery) {
    (
      service as unknown as {
        deliverPendingChildNotifications(sessionId: string, workspaceId: string): Promise<number>;
      }
    ).deliverPendingChildNotifications = deliverPendingChildNotifications;
  }

  return {
    service,
    repository,
    runtimeManager,
    sessionDomainService,
    acpEventProcessor,
    sessionConfigService,
    lifecycleEventService,
    notificationService,
    workspaceBridge,
    messageQueueBridge,
    session,
    workspace,
    handle,
    sendSessionMessage,
    deliverPendingChildNotifications,
    tryDispatchNextMessage: messageQueueBridge.tryDispatchNextMessage,
  };
}
