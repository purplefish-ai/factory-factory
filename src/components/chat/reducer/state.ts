import { createEmptyTokenStats, DEFAULT_CHAT_SETTINGS } from '@/lib/claude-types';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import type { ChatState } from './types';

function createBaseResetState(): Pick<
  ChatState,
  | 'messages'
  | 'gitBranch'
  | 'pendingRequest'
  | 'toolUseIdToIndex'
  | 'latestThinking'
  | 'pendingMessages'
  | 'lastRejectedMessage'
  | 'isCompacting'
  | 'toolProgress'
  | 'sessionInitData'
  | 'permissionMode'
  | 'hasCompactBoundary'
  | 'activeHooks'
  | 'taskNotifications'
  | 'tokenStats'
  | 'pendingUserMessageUuids'
  | 'messageIdToUuid'
  | 'localUserMessageIds'
  | 'rewindPreview'
> {
  // Note: slashCommands is intentionally NOT reset here.
  // - For CLEAR_CHAT: Commands persist because we're clearing messages in the same session.
  // - For session switches: SESSION_SNAPSHOT handles clearing slashCommands separately,
  //   and the backend will replay the stored slash_commands event for the new session.
  return {
    messages: [],
    gitBranch: null,
    pendingRequest: { type: 'none' },
    toolUseIdToIndex: new Map(),
    latestThinking: null,
    pendingMessages: new Map(),
    lastRejectedMessage: null,
    isCompacting: false,
    toolProgress: new Map(),
    sessionInitData: null,
    permissionMode: null,
    hasCompactBoundary: false,
    activeHooks: new Map(),
    taskNotifications: [],
    tokenStats: createEmptyTokenStats(),
    pendingUserMessageUuids: [],
    messageIdToUuid: new Map(),
    localUserMessageIds: new Set(),
    rewindPreview: null,
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
  | 'gitBranch'
  | 'pendingRequest'
  | 'toolUseIdToIndex'
  | 'latestThinking'
  | 'pendingMessages'
  | 'lastRejectedMessage'
  | 'queuedMessages'
  | 'sessionStatus'
  | 'isCompacting'
  | 'toolProgress'
  | 'sessionInitData'
  | 'permissionMode'
  | 'hasCompactBoundary'
  | 'activeHooks'
  | 'taskNotifications'
  | 'slashCommands'
  | 'slashCommandsLoaded'
  | 'tokenStats'
  | 'pendingUserMessageUuids'
  | 'messageIdToUuid'
  | 'localUserMessageIds'
  | 'rewindPreview'
  | 'processStatus'
  | 'sessionRuntime'
> {
  return {
    ...createBaseResetState(),
    queuedMessages: new Map(),
    sessionStatus: { phase: 'loading' },
    processStatus: { state: 'unknown' },
    sessionRuntime: {
      ...createInitialSessionRuntimeState(),
      phase: 'loading', // Override to 'loading' for session switch
    },
    slashCommands: [], // Clear for new session - will be sent when Claude starts
    slashCommandsLoaded: false,
  };
}

export function createInitialChatState(overrides?: Partial<ChatState>): ChatState {
  return {
    messages: [],
    sessionStatus: { phase: 'loading' },
    processStatus: { state: 'unknown' },
    sessionRuntime: createInitialSessionRuntimeState(),
    gitBranch: null,
    availableSessions: [],
    pendingRequest: { type: 'none' },
    chatSettings: DEFAULT_CHAT_SETTINGS,
    queuedMessages: new Map(),
    toolUseIdToIndex: new Map(),
    latestThinking: null,
    pendingMessages: new Map(),
    lastRejectedMessage: null,
    isCompacting: false,
    toolProgress: new Map(),
    sessionInitData: null,
    permissionMode: null,
    hasCompactBoundary: false,
    activeHooks: new Map(),
    taskNotifications: [],
    slashCommands: [],
    slashCommandsLoaded: false,
    tokenStats: createEmptyTokenStats(),
    pendingUserMessageUuids: [],
    messageIdToUuid: new Map(),
    localUserMessageIds: new Set(),
    rewindPreview: null,
    ...overrides,
  };
}

export { createBaseResetState, createSessionSwitchResetState };
