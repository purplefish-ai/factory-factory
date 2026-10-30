import { afterEach, describe, expect, it, vi } from 'vitest';

const buildSnapshotMessages = vi.hoisted(() => vi.fn(() => []));
vi.mock('./session-replay-builder', () => ({ buildSnapshotMessages }));

import {
  SESSION_OUTBOUND_EVENT,
  sessionEventBus,
} from '@/backend/services/session/service/session-event-bus';
import { SessionPublisher } from './session-publisher';
import { SessionStoreRegistry } from './session-store-registry';

describe('SessionPublisher.forwardSnapshot', () => {
  const listener = vi.fn();

  afterEach(() => {
    sessionEventBus.off(SESSION_OUTBOUND_EVENT, listener);
    sessionEventBus.registerViewerCountProvider(null);
    listener.mockReset();
    buildSnapshotMessages.mockClear();
  });

  function publishSnapshot(options?: { loadRequestId?: string }): void {
    sessionEventBus.on(SESSION_OUTBOUND_EVENT, listener);
    const store = new SessionStoreRegistry().getOrCreate('s1');
    new SessionPublisher().forwardSnapshot(store, { reason: 'enqueue', ...options });
  }

  it('skips building a snapshot when the transport reports no viewers', () => {
    sessionEventBus.registerViewerCountProvider(() => 0);
    publishSnapshot();
    expect(buildSnapshotMessages).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishes to sessions that have viewers', () => {
    sessionEventBus.registerViewerCountProvider(() => 1);
    publishSnapshot();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        payload: expect.objectContaining({ type: 'session_snapshot' }),
      })
    );
  });

  it('always publishes load replies', () => {
    sessionEventBus.registerViewerCountProvider(() => 0);
    publishSnapshot({ loadRequestId: 'load-1' });
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        payload: expect.objectContaining({ type: 'session_snapshot', loadRequestId: 'load-1' }),
      })
    );
  });

  it('publishes when no transport is attached', () => {
    publishSnapshot();
    expect(listener).toHaveBeenCalledOnce();
  });
});
