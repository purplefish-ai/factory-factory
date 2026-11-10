import { afterEach, expect, it, vi } from 'vitest';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/delivery/session-background-delivery.service';
import { SessionWorkflowFinalizer } from '@/backend/services/session/service/lifecycle/session-workflow-finalizer';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionConfigService, sessionDispatchService } from './session-services';

afterEach(() => vi.restoreAllMocks());

const settings = {
  selectedModel: null,
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};

// Workspace deletion cascades its session rows, then reports each through
// `forgetProviderHistoryIdentity`; it never calls `clearSession` itself.
it('clears every per-session collaborator when a cascaded session is forgotten', () => {
  const sessionId = 'cascade-deleted';
  const kept = 'cascade-kept';
  const config = vi.spyOn(sessionConfigService, 'releaseSessionConfiguration');
  const dispatch = vi.spyOn(sessionDispatchService, 'forgetSession');
  const delivery = vi.spyOn(sessionBackgroundDeliveryService, 'forgetSession');
  const finalizer = vi.spyOn(SessionWorkflowFinalizer.prototype, 'forgetSession');
  for (const id of [sessionId, kept]) {
    sessionDomainService.storeInitialMessage(id, 'Start the task');
    sessionDomainService.enqueue(id, { id: `${id}-q`, text: 'next', timestamp: '', settings });
  }

  sessionDomainService.forgetProviderHistoryIdentity(sessionId);

  expect(sessionDomainService.getQueueLength(sessionId)).toBe(0);
  expect(sessionDomainService.consumeInitialMessage(sessionId)).toBeNull();
  expect(sessionDomainService.getQueueLength(kept)).toBe(1);
  expect(config).toHaveBeenCalledExactlyOnceWith(sessionId);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(sessionId);
  expect(delivery).toHaveBeenCalledExactlyOnceWith(sessionId);
  expect(finalizer).toHaveBeenCalledExactlyOnceWith(sessionId);
  sessionDomainService.clearSession(kept);
});
