import { type Mock, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle, AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type {
  SessionLifecycleMessageQueueBridge,
  SessionLifecycleWorkspaceBridge,
} from '@/backend/services/session/service/bridges';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { workspaceNotificationService } from '@/backend/services/workspace';
import type { ChatMessage } from '@/shared/acp-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { SessionStatus, WorkspaceStatus } from '@/shared/core';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { AcpEventProcessor } from './acp-event-processor';
import type { SessionConfigService } from './session.config.service';
import { SessionLifecycleService } from './session.lifecycle.service';
import type { SessionPermissionService } from './session.permission.service';
import type { SessionRepository } from './session.repository';
import { SessionRetryService } from './session.retry.service';
import { SessionContextService, type SessionPermissionPresetPort } from './session-context.service';
import type { SessionAcpEnvironmentPort } from './session-lifecycle.types';
import type { SessionLifecycleEventService } from './session-lifecycle-event.service';
import { SessionLifecycleGate } from './session-lifecycle-gate';
import { SessionNotificationDeliveryService } from './session-notification-delivery.service';
import { SessionRuntimeExitCoordinator } from './session-runtime-exit.coordinator';
import { SessionStartupCoordinator } from './session-startup.coordinator';
import {
  SessionTerminationCoordinator,
  type SessionTerminationCoordinatorDependencies,
} from './session-termination.coordinator';
import { SessionWorkflowFinalizer } from './session-workflow-finalizer';

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
  getSessionById?: SessionRepository['getSessionById'];
  getSessionsByWorkspaceId?: SessionRepository['getSessionsByWorkspaceId'];
  getOrCreateClient?: AcpRuntimeManager['getOrCreateClient'];
  enqueue?: SessionDomainService['enqueue'];
  transcript?: ChatMessage[];
  historyHydrationSource?: 'jsonl' | 'acp_fallback' | 'none';
  tryDispatchNextMessage?: SessionLifecycleMessageQueueBridge['tryDispatchNextMessage'];
  getPermissionPreset?: SessionPermissionPresetPort['getPermissionPreset'];
  provider?: AgentSessionRecord['provider'];
  providerSessionId?: string | null;
  providerProcessPid?: number | null;
  worktreePath?: string | null;
};

type MockedPick<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: never[]) => unknown ? Mock<T[P]> & T[P] : T[P];
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
    | 'deleteSession'
    | 'recoverStaleRunningSessions'
  >;
  runtimeManager: MockedPick<
    AcpRuntimeManager,
    | 'isStopInProgress'
    | 'isSessionRunning'
    | 'hasClientCreationOperation'
    | 'isBrowseOnlySession'
    | 'isSessionWorking'
    | 'getClient'
    | 'getBrowseClient'
    | 'getPendingClient'
    | 'getSubagentBrowseCapability'
    | 'getOrCreateClient'
    | 'runClientCreationOperation'
    | 'stopClient'
    | 'stopAndQuiesce'
    | 'beginShutdown'
    | 'stopAllClients'
  >;
  sessionDomainService: MockedPick<
    SessionDomainService,
    | 'appendClaudeEvent'
    | 'emitDelta'
    | 'hasQueuedMessage'
    | 'enqueue'
    | 'removeQueuedMessage'
    | 'getTranscriptSnapshot'
    | 'getHistoryHydrationSource'
    | 'setRuntimeSnapshot'
    | 'isHistoryHydrated'
    | 'getRuntimeSnapshot'
    | 'clearQueuedWork'
    | 'clearSession'
    | 'markProcessExit'
    | 'markError'
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
    | 'clearPendingToolCalls'
    | 'clearSessionContext'
    | 'getWorkspaceId'
    | 'handleAcpLog'
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
  contextService: SessionContextService;
  acpEnvironment: MockedPick<SessionAcpEnvironmentPort, 'getBackendPort' | 'getMcpServers'>;
  lifecycleGate: SessionLifecycleGate;
  notificationDeliveryService: SessionNotificationDeliveryService;
  notificationService: MockedPick<SessionPermissionService, 'cancelPendingRequests'>;
  workspaceBridge: MockedPick<
    SessionLifecycleWorkspaceBridge,
    'markSessionRunning' | 'markSessionIdle' | 'recordRatchetSessionEnd' | 'resetPRDiscoveryBackoff'
  >;
  messageQueueBridge: MockedPick<SessionLifecycleMessageQueueBridge, 'tryDispatchNextMessage'>;
  session: AgentSessionRecord;
  workspace: LifecycleTestWorkspace;
  handle: AcpProcessHandle;
  sendSessionMessage: Mock<(sessionId: string, content: string) => Promise<void>>;
  tryDispatchNextMessage: Mock<SessionLifecycleMessageQueueBridge['tryDispatchNextMessage']>;
};

export type TerminationHarness = {
  coordinator: SessionTerminationCoordinator;
  repository: MockedPick<
    SessionRepository,
    'getSessionById' | 'getSessionsByWorkspaceId' | 'updateSessionIfStatus'
  >;
  retryService: SessionTerminationCoordinatorDependencies['retryService'];
  runtimeManager: MockedPick<
    AcpRuntimeManager,
    | 'getClient'
    | 'isSessionWorking'
    | 'isStopInProgress'
    | 'isSessionRunning'
    | 'hasClientCreationOperation'
    | 'isBrowseOnlySession'
    | 'stopAndQuiesce'
    | 'beginShutdown'
    | 'stopAllClients'
  >;
  sessionDomainService: MockedPick<
    SessionDomainService,
    'clearQueuedWork' | 'getRuntimeSnapshot' | 'setRuntimeSnapshot'
  >;
  sessionPermissionService: MockedPick<SessionPermissionService, 'cancelPendingRequests'>;
  acpEventProcessor: MockedPick<
    AcpEventProcessor,
    | 'clearSessionState'
    | 'clearStreamingState'
    | 'clearReplaySuppression'
    | 'finalizeOrphanedToolCalls'
    | 'clearPendingToolCalls'
    | 'getWorkspaceId'
  >;
  promptTurnCompletionService: {
    clearSession: Mock<(sessionId: string) => void>;
    clearAll: Mock<() => void>;
  };
  lifecycleEventService: MockedPick<SessionLifecycleEventService, 'record'>;
  lifecycleGate: SessionLifecycleGate;
  workflowFinalizer: MockedPick<
    SessionWorkflowFinalizer,
    'finalizeDeliberateStop' | 'clearInactiveSession'
  >;
  workspaceBridge: MockedPick<SessionLifecycleWorkspaceBridge, 'markSessionIdle'>;
  getRuntimeSnapshot: Mock<(sessionId: string) => SessionRuntimeState>;
  session: AgentSessionRecord;
};

export type TerminationHarnessOverrides = Pick<
  LifecycleHarnessOverrides,
  'session' | 'getSessionById' | 'getSessionsByWorkspaceId'
> & {
  onBeforeStopSession?: (sessionId: string) => void;
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

export function createTerminationHarness(
  overrides: TerminationHarnessOverrides = {}
): TerminationHarness {
  const session = createLifecycleTestSession(overrides.session);
  const repository = {
    getSessionById: vi.fn<SessionRepository['getSessionById']>(
      overrides.getSessionById ?? (async (sessionId) => ({ ...session, id: sessionId }))
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
    updateSessionIfStatus: vi.fn<SessionRepository['updateSessionIfStatus']>(async () => 0),
  } satisfies Pick<
    SessionRepository,
    'getSessionById' | 'getSessionsByWorkspaceId' | 'updateSessionIfStatus'
  >;
  const retryService = new SessionRetryService();
  const runtimeManager = {
    getClient: vi.fn(() => undefined),
    isSessionWorking: vi.fn(() => false),
    isStopInProgress: vi.fn(() => false),
    isSessionRunning: vi.fn((sessionId: string) => sessionId === 'session-runtime-only'),
    hasClientCreationOperation: vi.fn(() => false),
    isBrowseOnlySession: vi.fn((sessionId: string) => sessionId === 'session-browse-only'),
    stopAndQuiesce: vi.fn(async () => undefined),
    beginShutdown: vi.fn(() => []),
    stopAllClients: vi.fn(async () => undefined),
  } satisfies Pick<
    AcpRuntimeManager,
    | 'getClient'
    | 'isSessionWorking'
    | 'isStopInProgress'
    | 'isSessionRunning'
    | 'hasClientCreationOperation'
    | 'isBrowseOnlySession'
    | 'stopAndQuiesce'
    | 'beginShutdown'
    | 'stopAllClients'
  >;
  const sessionDomainService = {
    clearQueuedWork: vi.fn(),
    getRuntimeSnapshot: vi.fn<SessionDomainService['getRuntimeSnapshot']>(() => ({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-07-15T00:00:00.000Z',
    })),
    setRuntimeSnapshot: vi.fn(),
  } satisfies Pick<
    SessionDomainService,
    'clearQueuedWork' | 'getRuntimeSnapshot' | 'setRuntimeSnapshot'
  >;
  const sessionPermissionService = {
    cancelPendingRequests: vi.fn<SessionPermissionService['cancelPendingRequests']>(),
  } satisfies Pick<SessionPermissionService, 'cancelPendingRequests'>;
  const acpEventProcessor = {
    clearSessionState: vi.fn(),
    clearStreamingState: vi.fn(),
    clearReplaySuppression: vi.fn(),
    finalizeOrphanedToolCalls: vi.fn(),
    clearPendingToolCalls: vi.fn(),
    getWorkspaceId: vi.fn(() => undefined),
  } satisfies Pick<
    AcpEventProcessor,
    | 'clearSessionState'
    | 'clearStreamingState'
    | 'clearReplaySuppression'
    | 'finalizeOrphanedToolCalls'
    | 'clearPendingToolCalls'
    | 'getWorkspaceId'
  >;
  const promptTurnCompletionService = {
    clearSession: vi.fn<(sessionId: string) => void>(),
    clearAll: vi.fn<() => void>(),
  };
  const lifecycleEventService = {
    record: vi.fn<SessionLifecycleEventService['record']>(async () => null),
  } satisfies Pick<SessionLifecycleEventService, 'record'>;
  const workflowFinalizer = {
    finalizeDeliberateStop: vi.fn(async () => undefined),
    clearInactiveSession: vi.fn(),
  } satisfies Pick<SessionWorkflowFinalizer, 'finalizeDeliberateStop' | 'clearInactiveSession'>;
  const workspaceBridge = {
    markSessionIdle: vi.fn(),
  } satisfies Pick<SessionLifecycleWorkspaceBridge, 'markSessionIdle'>;
  const lifecycleGate = new SessionLifecycleGate({
    isRuntimeStopInProgress: () => false,
  });
  const getRuntimeSnapshot = vi.fn(() => ({
    phase: 'idle' as const,
    processState: 'stopped' as const,
    activity: 'IDLE' as const,
    updatedAt: '2026-07-15T00:00:00.000Z',
  }));
  const coordinator = new SessionTerminationCoordinator({
    repository,
    retryService,
    runtimeManager,
    sessionDomainService,
    sessionPermissionService,
    acpEventProcessor,
    promptTurnCompletionService,
    lifecycleEventService,
    lifecycleGate,
    workflowFinalizer,
    getRuntimeSnapshot,
    onBeforeStopSession: overrides.onBeforeStopSession,
  });
  coordinator.configure({ workspace: workspaceBridge });

  return {
    coordinator,
    repository,
    retryService,
    runtimeManager,
    sessionDomainService,
    sessionPermissionService,
    acpEventProcessor,
    promptTurnCompletionService,
    lifecycleEventService,
    lifecycleGate,
    workflowFinalizer,
    workspaceBridge,
    getRuntimeSnapshot,
    session,
  };
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

export function createPendingWorkspaceNotification(
  overrides: Partial<{
    id: string;
    workspaceId: string;
    sourceWorkspaceId: string;
    sourceWorkspaceName: string;
    sourceProjectName: string;
    message: string;
    direction: 'PARENT_TO_CHILD' | 'CHILD_TO_PARENT';
    deliveredAt: Date | null;
    createdAt: Date;
  }> = {}
) {
  return {
    id: 'notif-parent',
    workspaceId: 'workspace-1',
    sourceWorkspaceId: 'parent-workspace',
    sourceWorkspaceName: 'Parent Workspace',
    sourceProjectName: 'Parent Project',
    message: 'Please check the failing test.',
    direction: 'PARENT_TO_CHILD' as const,
    deliveredAt: null,
    createdAt: new Date('2026-06-22T10:30:00.000Z'),
    ...overrides,
  };
}

export function createLifecycleHarness(
  overrides: LifecycleHarnessOverrides = {}
): LifecycleHarness {
  const session = createLifecycleTestSession({
    provider: overrides.provider ?? 'CLAUDE',
    providerSessionId: overrides.providerSessionId ?? null,
    providerProcessPid:
      overrides.providerProcessPid === undefined ? 4242 : overrides.providerProcessPid,
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
    deleteSession: vi.fn<SessionRepository['deleteSession']>(async () => session),
    recoverStaleRunningSessions: vi.fn<SessionRepository['recoverStaleRunningSessions']>(
      async () => 0
    ),
  } satisfies Pick<
    SessionRepository,
    | 'getSessionById'
    | 'getSessionsByWorkspaceId'
    | 'getWorkspaceById'
    | 'getProjectById'
    | 'markWorkspaceHasHadSessions'
    | 'updateSession'
    | 'updateSessionIfStatus'
    | 'deleteSession'
    | 'recoverStaleRunningSessions'
  >;
  const runClientCreationOperation: AcpRuntimeManager['runClientCreationOperation'] = async (
    _sessionId,
    _purpose,
    operation
  ) => await operation({ isOnlyOperation: () => true });
  const runtimeManager = {
    isStopInProgress: vi.fn((_sessionId: string) => false),
    isSessionRunning: vi.fn((sessionId: string) => sessionId === 'session-runtime-only'),
    hasClientCreationOperation: vi.fn(() => false),
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
    runClientCreationOperation: vi.fn(runClientCreationOperation) as Mock<
      AcpRuntimeManager['runClientCreationOperation']
    > &
      AcpRuntimeManager['runClientCreationOperation'],
    stopClient: vi.fn(async () => undefined),
    stopAndQuiesce: vi.fn(async () => undefined),
    beginShutdown: vi.fn(() => []),
    stopAllClients: vi.fn(async () => undefined),
  } satisfies Pick<
    AcpRuntimeManager,
    | 'isStopInProgress'
    | 'isSessionRunning'
    | 'hasClientCreationOperation'
    | 'isBrowseOnlySession'
    | 'isSessionWorking'
    | 'getClient'
    | 'getBrowseClient'
    | 'getPendingClient'
    | 'getSubagentBrowseCapability'
    | 'getOrCreateClient'
    | 'runClientCreationOperation'
    | 'stopClient'
    | 'stopAndQuiesce'
    | 'beginShutdown'
    | 'stopAllClients'
  >;
  const sessionDomainService = {
    appendClaudeEvent: vi.fn((_sessionId: string, _message: unknown) => 1),
    emitDelta: vi.fn(),
    hasQueuedMessage: vi.fn((_sessionId: string, _messageId: string) => false),
    enqueue: vi.fn<SessionDomainService['enqueue']>(overrides.enqueue ?? (() => ({ position: 0 }))),
    removeQueuedMessage: vi.fn(() => true),
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
    markError: vi.fn(),
  } satisfies Pick<
    SessionDomainService,
    | 'appendClaudeEvent'
    | 'emitDelta'
    | 'hasQueuedMessage'
    | 'enqueue'
    | 'removeQueuedMessage'
    | 'getTranscriptSnapshot'
    | 'getHistoryHydrationSource'
    | 'setRuntimeSnapshot'
    | 'isHistoryHydrated'
    | 'getRuntimeSnapshot'
    | 'clearQueuedWork'
    | 'clearSession'
    | 'markProcessExit'
    | 'markError'
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
    clearPendingToolCalls: vi.fn(),
    clearSessionContext: vi.fn(),
    getWorkspaceId: vi.fn(() => undefined),
    handleAcpLog: vi.fn(),
  } satisfies Pick<
    AcpEventProcessor,
    | 'createRuntimeEventHandler'
    | 'registerSessionContext'
    | 'setReplaySuppression'
    | 'clearSessionState'
    | 'clearStreamingState'
    | 'clearReplaySuppression'
    | 'finalizeOrphanedToolCalls'
    | 'clearPendingToolCalls'
    | 'clearSessionContext'
    | 'getWorkspaceId'
    | 'handleAcpLog'
  >;
  const lifecycleEventService = {
    record: vi.fn<SessionLifecycleEventService['record']>(async () => null),
    hydrate: vi.fn(async () => undefined),
  } satisfies Pick<SessionLifecycleEventService, 'record' | 'hydrate'>;
  const notificationService = {
    cancelPendingRequests: vi.fn<SessionPermissionService['cancelPendingRequests']>(),
  } satisfies Pick<SessionPermissionService, 'cancelPendingRequests'>;
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
  const lifecycleGate = new SessionLifecycleGate({
    isRuntimeStopInProgress: (sessionId) => runtimeManager.isStopInProgress(sessionId),
  });
  const promptBuilder = {
    shouldInjectBranchRename: vi.fn(() => false),
    buildSystemPrompt: vi.fn(() => ({
      workflowPrompt: undefined,
      systemPrompt: 'system prompt',
      injectedBranchRename: false,
    })),
  };
  const contextService = new SessionContextService({
    repository,
    promptBuilder,
    permissionPresetPort: {
      getPermissionPreset:
        overrides.getPermissionPreset ??
        ((workflow) => Promise.resolve(workflow === 'ratchet' ? 'YOLO' : 'STRICT')),
    },
  });
  const acpEnvironment = {
    getBackendPort: vi.fn(() => 4000),
    getMcpServers: vi.fn(() => [
      {
        name: 'workspace-tools',
        command: 'workspace-tools-server',
        args: [],
        env: {},
      },
    ]),
  } satisfies SessionAcpEnvironmentPort;
  const promptTurnCompletionService = { clearSession: vi.fn(), clearAll: vi.fn() };
  const retryService = {
    run: vi.fn(async (operation: () => Promise<unknown>) => await operation()),
  };
  const notificationDeliveryService = new SessionNotificationDeliveryService({
    notificationPort: workspaceNotificationService,
    queuePort: sessionDomainService,
    transcriptPort: sessionDomainService,
    deltaPort: sessionDomainService,
  });
  const workflowFinalizer = new SessionWorkflowFinalizer(
    unsafeCoerce({
      repository,
      workspaceLookup: { findById: async () => workspace },
      sessionDomainService,
      closedSessionPersistenceService: { persistClosedSession: vi.fn(async () => undefined) },
      lifecycleEventService,
      hydrateProviderHistory: async () => undefined,
      runtimeManager,
      countViewers: () => 0,
    })
  );
  const runtimeExitCoordinator = new SessionRuntimeExitCoordinator(
    unsafeCoerce({
      repository,
      sessionDomainService,
      sessionPermissionService: notificationService,
      acpEventProcessor,
      promptTurnCompletionService,
      lifecycleEventService,
      lifecycleGate,
      workflowFinalizer,
      onSessionExit: vi.fn(),
    })
  );
  let service: SessionLifecycleService;
  const terminationCoordinator = new SessionTerminationCoordinator(
    unsafeCoerce({
      repository,
      retryService,
      runtimeManager,
      sessionDomainService,
      sessionPermissionService: notificationService,
      acpEventProcessor,
      promptTurnCompletionService,
      lifecycleEventService,
      lifecycleGate,
      workflowFinalizer,
      getRuntimeSnapshot: (sessionId: string) => service.getRuntimeSnapshot(sessionId),
    })
  );
  const startupCoordinator = new SessionStartupCoordinator(
    unsafeCoerce({
      repository,
      contextService,
      acpEnvironment,
      runtimeManager,
      sessionDomainService,
      sessionConfigService,
      acpEventProcessor,
      runtimeExitCoordinator,
      lifecycleGate,
      notificationDelivery: notificationDeliveryService,
      sendSessionMessage,
      stopSession: (sessionId: string, options: unknown) =>
        service.stopSession(sessionId, unsafeCoerce(options)),
    })
  );
  service = new SessionLifecycleService({
    startupCoordinator,
    terminationCoordinator,
    workflowFinalizer,
    contextService,
    runtimeManager,
    sessionDomainService,
    lifecycleGate,
  });
  service.configure({ workspace: workspaceBridge, messageQueue: messageQueueBridge });

  return {
    service,
    repository,
    runtimeManager,
    sessionDomainService,
    acpEventProcessor,
    sessionConfigService,
    lifecycleEventService,
    contextService,
    acpEnvironment,
    lifecycleGate,
    notificationDeliveryService,
    notificationService,
    workspaceBridge,
    messageQueueBridge,
    session,
    workspace,
    handle,
    sendSessionMessage,
    tryDispatchNextMessage: messageQueueBridge.tryDispatchNextMessage,
  };
}
