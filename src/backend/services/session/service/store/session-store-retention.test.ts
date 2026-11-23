import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, QueuedMessage } from '@/shared/acp-protocol';
import { SessionDomainService } from './session-domain.service';
import {
  MAX_RETAINED_SESSION_STORES,
  SESSION_STORE_RETENTION_GRACE_MS,
} from './session-store-retention';
import type { HistoryFileIdentity } from './session-store.types';

const historyFile: HistoryFileIdentity = {
  filePath: '/history/s.jsonl',
  size: 10,
  mtimeMs: 1,
  ino: 2,
};
const idle = () => true;

function row(sessionId: string, order: number): ChatMessage {
  return {
    id: `${sessionId}-${order}`,
    source: 'user',
    text: `row ${order}`,
    timestamp: '2026-11-23T00:00:00.000Z',
    order,
  };
}

function queued(id: string): QueuedMessage {
  return {
    id,
    text: 'later',
    timestamp: '2026-11-23T00:00:00.000Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
}

let domain: SessionDomainService;
let cleared: string[];

function hydrate(sessionId: string, file: HistoryFileIdentity | null = historyFile) {
  domain.replaceTranscript(sessionId, [row(sessionId, 0), row(sessionId, 1)], {
    historySource: 'jsonl',
    ...(file ? { historyFile: file } : {}),
  });
  return domain.captureStoreGuard(sessionId);
}

beforeEach(() => {
  vi.useFakeTimers();
  domain = new SessionDomainService();
  cleared = [];
  domain.on('session_cleared', (sessionId: string) => cleared.push(sessionId));
});

afterEach(() => {
  domain.clearAllSessions();
  vi.useRealTimers();
});

describe('retaining an idle store after its last viewer leaves', () => {
  it('keeps the store for the grace period, then clears it once', () => {
    const current = hydrate('s1');
    domain.releaseViewerless('s1', idle);

    vi.advanceTimersByTime(SESSION_STORE_RETENTION_GRACE_MS - 1);
    expect(current()).toBe(true);
    expect(cleared).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(current()).toBe(false);
    expect(cleared).toEqual(['s1']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a store that became used again when its grace period ends', () => {
    const current = hydrate('s1');
    let viewers = 0;
    domain.releaseViewerless('s1', () => viewers === 0);
    viewers = 1;

    vi.advanceTimersByTime(SESSION_STORE_RETENTION_GRACE_MS);
    expect(current()).toBe(true);
    expect(cleared).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a store that never finished hydrating at once', () => {
    domain.getRuntimeSnapshot('s1');
    domain.releaseViewerless('s1', idle);
    expect(cleared).toEqual(['s1']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the longest retained store early when one more than the cap is released', () => {
    const guards = Array.from({ length: MAX_RETAINED_SESSION_STORES + 1 }, (_, index) =>
      hydrate(`s${index}`)
    );
    for (let index = 0; index < MAX_RETAINED_SESSION_STORES; index += 1) {
      domain.releaseViewerless(`s${index}`, idle);
    }
    expect(cleared).toEqual([]);

    domain.releaseViewerless(`s${MAX_RETAINED_SESSION_STORES}`, idle);
    expect(cleared).toEqual(['s0']);
    expect(guards.map((current) => current())).toEqual([
      false,
      ...Array(MAX_RETAINED_SESSION_STORES).fill(true),
    ]);
    expect(vi.getTimerCount()).toBe(MAX_RETAINED_SESSION_STORES);
  });

  it('counts a released-again store as the most recent', () => {
    for (let index = 0; index < MAX_RETAINED_SESSION_STORES; index += 1) {
      hydrate(`s${index}`);
      domain.releaseViewerless(`s${index}`, idle);
    }
    domain.releaseViewerless('s0', idle);
    hydrate('extra');
    domain.releaseViewerless('extra', idle);
    expect(cleared).toEqual(['s1']);
  });

  it('stops counting down when a load claims the store', () => {
    const current = hydrate('s1');
    domain.releaseViewerless('s1', idle);
    const claim = domain.claimRetainedStore('s1');

    expect(claim?.historyFile).toEqual(historyFile);
    vi.advanceTimersByTime(SESSION_STORE_RETENTION_GRACE_MS * 2);
    expect(current()).toBe(true);
    expect(cleared).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(domain.claimRetainedStore('s1')).toBeUndefined();
  });

  it('stops counting down when the store is used again without a viewer', () => {
    const current = hydrate('s1');
    domain.releaseViewerless('s1', idle);
    domain.enqueue('s1', queued('background'));

    vi.advanceTimersByTime(SESSION_STORE_RETENTION_GRACE_MS * 2);
    expect(current()).toBe(true);
    expect(domain.getQueueLength('s1')).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('claims only retained stores hydrated from a history file', () => {
    hydrate('viewed');
    expect(domain.claimRetainedStore('viewed')).toBeUndefined();

    domain.replaceTranscript('live', [row('live', 0)], { historySource: 'none' });
    domain.releaseViewerless('live', idle);
    expect(domain.claimRetainedStore('live')).toBeUndefined();

    hydrate('unidentified', null);
    domain.releaseViewerless('unidentified', idle);
    expect(domain.claimRetainedStore('unidentified')).toEqual({
      historyFile: undefined,
      discard: expect.any(Function),
    });
  });

  it('discards a claimed store only while it is still the current store', () => {
    const current = hydrate('s1');
    domain.releaseViewerless('s1', idle);
    const claim = domain.claimRetainedStore('s1');
    claim?.discard();
    expect(current()).toBe(false);
    expect(cleared).toEqual(['s1']);

    const replacement = hydrate('s1');
    claim?.discard();
    expect(replacement()).toBe(true);
    expect(cleared).toEqual(['s1']);
  });

  it('drops the recorded history file when hydration is marked again without one', () => {
    hydrate('s1');
    domain.resetProviderHistory('s1', 'provider-2');
    domain.markHistoryHydrated('s1', 'jsonl');
    domain.releaseViewerless('s1', idle);
    expect(domain.claimRetainedStore('s1')?.historyFile).toBeUndefined();
  });
});

describe('ending retention without leaving a timer', () => {
  it('cancels the countdown when the session is cleared or forgotten', () => {
    hydrate('cleared');
    hydrate('deleted');
    domain.releaseViewerless('cleared', idle);
    domain.releaseViewerless('deleted', idle);

    domain.clearSession('cleared');
    domain.clearSession('deleted', { permanentlyDeleted: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(cleared).toEqual(['cleared', 'deleted']);
  });

  it('cancels every countdown when all sessions are cleared', () => {
    hydrate('a');
    hydrate('b');
    domain.releaseViewerless('a', idle);
    domain.releaseViewerless('b', idle);

    domain.clearAllSessions();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SESSION_STORE_RETENTION_GRACE_MS);
    expect(cleared).toEqual([]);
  });

  it('clears retained stores on shutdown and clears later releases at once', () => {
    const current = hydrate('a');
    domain.releaseViewerless('a', idle);

    domain.stopStoreRetention();
    expect(current()).toBe(false);
    expect(cleared).toEqual(['a']);
    expect(vi.getTimerCount()).toBe(0);

    hydrate('late');
    domain.releaseViewerless('late', idle);
    expect(cleared).toEqual(['a', 'late']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
