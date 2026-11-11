import { createEmptyTokenStats, DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import type { ChatState } from './types';

function createBaseResetState(): Pick<
  ChatState,
  | 'messages'
  | 'transcriptHistory'
  | 'transcriptPageBoundaries'
  | 'gitBranch'
  | 'pendingRequest'
  | 'toolUseIdToIndex'
  | 'agentMessageOrderToIndex'
  | 'latestThinking'
  | 'latestThinkingOrder'
  | 'latestThinkingDeltaOrder'
  | 'pendingMessages'
  | 'pendingSteer'
  | 'lastRejectedMessage'
  | 'isCompacting'
  | 'toolProgress'
  | 'hasCompactBoundary'
  | 'taskNotifications'
  | 'tokenStats'
  | 'countedResultOrders'
  | 'acpPlan'
  | 'acpConfigOptions'
> {
  // Note: slashCommands is intentionally NOT reset here.
  // - For CLEAR_CHAT: Commands persist because we're clearing messages in the same session.
  // - For session switches: SESSION_SNAPSHOT handles clearing slashCommands separately,
  //   and the backend will replay the stored slash_commands event for the new session.
  return {
    messages: [],
    transcriptHistory: { status: 'idle' },
    transcriptPageBoundaries: new Set(),
    gitBranch: null,
    pendingRequest: { type: 'none' },
    toolUseIdToIndex: new Map(),
    agentMessageOrderToIndex: new Map(),
    latestThinking: null,
    latestThinkingOrder: null,
    latestThinkingDeltaOrder: null,
    pendingMessages: new Map(),
    pendingSteer: null,
    lastRejectedMessage: null,
    isCompacting: false,
    toolProgress: new Map(),
    hasCompactBoundary: false,
    taskNotifications: [],
    tokenStats: createEmptyTokenStats(),
    countedResultOrders: new Set(),
    acpPlan: null,
    acpConfigOptions: null,
  };
}

/**
 * Creates extended reset state for session switches.
 * Note: queuedMessages is included in the type but cleared in this function.
 * The SESSION_SWITCH_START reducer preserves queuedMessages from the previous state
 * to avoid visual disappearance until the replay batch replaces them.
 */
function createSessionSwitchResetState(): Pick<
  ChatState,
  | 'messages'
  | 'transcriptHistory'
  | 'transcriptPageBoundaries'
  | 'rendererTranscriptLimit'
  | 'gitBranch'
  | 'pendingRequest'
  | 'toolUseIdToIndex'
  | 'agentMessageOrderToIndex'
  | 'latestThinking'
  | 'latestThinkingOrder'
  | 'latestThinkingDeltaOrder'
  | 'pendingMessages'
  | 'pendingSteer'
  | 'lastRejectedMessage'
  | 'queuedMessages'
  | 'sessionStatus'
  | 'isCompacting'
  | 'toolProgress'
  | 'hasCompactBoundary'
  | 'taskNotifications'
  | 'slashCommands'
  | 'slashCommandsLoaded'
  | 'tokenStats'
  | 'countedResultOrders'
  | 'processStatus'
  | 'sessionRuntime'
  | 'hydratedSessionId'
  | 'controlsHydratedSessionId'
  | 'chatCapabilities'
  | 'chatCapabilitiesLoaded'
  | 'modelSelectionSource'
  | 'pendingModelRequestId'
  | 'pendingConfigOptions'
  | 'needsConfigReconciliation'
  | 'acpConfigOptions'
> {
  return {
    ...createBaseResetState(),
    rendererTranscriptLimit: undefined,
    queuedMessages: new Map(),
    sessionStatus: { phase: 'loading' },
    processStatus: { state: 'unknown' },
    sessionRuntime: {
      ...createInitialSessionRuntimeState(),
      phase: 'loading', // Override to 'loading' for session switch
    },
    hydratedSessionId: null,
    controlsHydratedSessionId: null,
    slashCommands: [], // Clear for new session - populated on session load from cache/disk scan
    slashCommandsLoaded: false,
    chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
    chatCapabilitiesLoaded: false,
    modelSelectionSource: 'bootstrap',
    pendingModelRequestId: null,
    pendingConfigOptions: new Map(),
    needsConfigReconciliation: false,
  };
}

export function createInitialChatState(overrides?: Partial<ChatState>): ChatState {
  return {
    messages: [],
    transcriptHistory: { status: 'idle' },
    transcriptPageBoundaries: new Set(),
    rendererTranscriptLimit: undefined,
    sessionStatus: { phase: 'loading' },
    processStatus: { state: 'unknown' },
    sessionRuntime: createInitialSessionRuntimeState(),
    hydratedSessionId: null,
    controlsHydratedSessionId: null,
    gitBranch: null,
    pendingRequest: { type: 'none' },
    chatSettings: DEFAULT_CHAT_SETTINGS,
    chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
    chatCapabilitiesLoaded: false,
    modelSelectionSource: 'bootstrap',
    pendingModelRequestId: null,
    pendingConfigOptions: new Map(),
    needsConfigReconciliation: false,
    queuedMessages: new Map(),
    toolUseIdToIndex: new Map(),
    agentMessageOrderToIndex: new Map(),
    latestThinking: null,
    latestThinkingOrder: null,
    latestThinkingDeltaOrder: null,
    pendingMessages: new Map(),
    pendingSteer: null,
    lastRejectedMessage: null,
    isCompacting: false,
    toolProgress: new Map(),
    hasCompactBoundary: false,
    taskNotifications: [],
    slashCommands: [],
    slashCommandsLoaded: false,
    tokenStats: createEmptyTokenStats(),
    countedResultOrders: new Set(),
    acpPlan: null,
    acpConfigOptions: null,
    ...overrides,
  };
}

export { createBaseResetState, createSessionSwitchResetState };
