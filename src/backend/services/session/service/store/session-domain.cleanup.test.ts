import { afterEach, expect, it, vi } from 'vitest';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { SessionDomainService } from './session-domain.service';
import { SessionStoreRegistry } from './session-store-registry';

const domains: SessionDomainService[] = [];
afterEach(() => {
  for (const domain of domains.splice(0)) {
    domain.clearAllSessions();
  }
  vi.useRealTimers();
});
function fixture() {
  const domain = new SessionDomainService();
  domains.push(domain);
  const stores: Array<{
    registry: SessionStoreRegistry;
    store: ReturnType<SessionStoreRegistry['getOrCreate']>;
  }> = [];
  const read = SessionStoreRegistry.prototype.getOrCreate;
  const lookup = vi
    .spyOn(SessionStoreRegistry.prototype, 'getOrCreate')
    .mockImplementation(function (this: SessionStoreRegistry, id) {
      const store = read.call(this, id);
      stores.push({ registry: this, store });
      return store;
    });
  const publish = vi.spyOn(sessionEventBus, 'publishToSession').mockImplementation(() => undefined);
  return { domain, stores, lookup, publish };
}
it.each([false, true])(
  'queue cleanup neither allocates missing nor replaces empty stores, existing=%s',
  (existing) => {
    const { domain, lookup, stores, publish } = fixture();
    if (existing) {
      domain.getRuntimeSnapshot('cleanup');
    }
    const captured = stores.at(-1);
    lookup.mockClear();
    publish.mockClear();
    domain.clearQueuedWork('cleanup', { emitSnapshot: true });
    expect(domain.getQueueLength('cleanup')).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    if (captured) {
      expect(captured.registry.isCurrentStore('cleanup', captured.store)).toBe(true);
    }
  }
);
it('queue cleanup does not activate a preservation-only store or prevent its expiration', async () => {
  vi.useFakeTimers();
  const { domain, stores, publish } = fixture();
  domain.failMessage(
    'preserved',
    {
      id: 'failed',
      text: 'Recover draft',
      timestamp: '',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    },
    'Stopped'
  );
  domain.clearSession('preserved', { preserveRejections: true });
  const captured = stores.at(-1);
  if (!captured) {
    throw new Error('Missing preserved store');
  }
  publish.mockClear();
  domain.clearQueuedWork('preserved', { emitSnapshot: true });
  expect(domain.getQueueLength('preserved')).toBe(0);
  expect(captured.registry.isCurrentStore('preserved', captured.store)).toBe(true);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(captured.registry.isCurrentStore('preserved', captured.store)).toBe(false);
  expect(publish).not.toHaveBeenCalled();
});
