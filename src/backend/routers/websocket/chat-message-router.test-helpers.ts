import { vi } from 'vitest';
import type { SessionCommandFactories } from '@/backend/services/session';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import type { ChatMessageRouterServices } from './chat-message-router';

export function createChatRouterServices(
  factories: SessionCommandFactories
): ChatMessageRouterServices {
  return {
    factories,
    execution: {
      domain: {
        markError: vi.fn(),
        rejectMessage: vi.fn(),
        enqueue: vi.fn(() => ({ position: 0 })),
        emitDelta: vi.fn(),
        removeQueuedMessage: vi.fn(() => true),
      },
      lifecycle: {
        getSessionOptions: vi.fn(async () => null),
        stopSession: vi.fn(async () => undefined),
      },
      backgroundDelivery: {
        captureResumeGuard: vi.fn(() => () => true),
        userResume: vi.fn(async () => undefined),
      },
      clearPendingRequest: vi.fn(),
    },
    runtime: { isSessionRunning: vi.fn(() => false) },
    config: {
      setSessionModel: vi.fn(async () => undefined),
      setSessionReasoningEffort: vi.fn(async () => undefined),
      getChatBarCapabilities: vi.fn(async () => EMPTY_CHAT_BAR_CAPABILITIES),
      setSessionThinkingBudget: vi.fn(async () => undefined),
      setSessionConfigOption: vi.fn(async () => undefined),
      getSessionConfigOptions: vi.fn(() => []),
    },
    permission: { respondToPermission: vi.fn(() => true) },
    prompt: { sendSessionMessage: vi.fn(async () => undefined) },
    startup: { getSessionClient: vi.fn(), getOrCreateSessionClient: vi.fn(async () => undefined) },
    dispatch: {
      steerQueuedMessage: vi.fn().mockResolvedValue(undefined),
      tryDispatchNextMessage: vi.fn(async () => undefined),
      setManualDispatchResume: vi.fn(),
      resetDispatchState: vi.fn(),
    },
    load: {
      prepareLoad: vi.fn(async () => ({ status: 'error' as const, outcome: { replies: [] } })),
      captureReplay: vi.fn(() => ({
        replayEvents: [],
        sessionRuntime: {
          phase: 'idle',
          processState: 'stopped',
          activity: 'IDLE',
          updatedAt: '2026-10-27T12:00:00.000Z',
        } as const,
      })),
      completeLoad: vi.fn(async () => undefined),
    },
    eventBus: { publishToSession: vi.fn() },
    fileLogger: { log: vi.fn() },
  };
}
