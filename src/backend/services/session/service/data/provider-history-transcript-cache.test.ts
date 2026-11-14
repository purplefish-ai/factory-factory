import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryFileIdentity } from '@/backend/services/session/service/data/session-history-file';
import type { ChatMessage } from '@/shared/acp-protocol';
import { ProviderHistoryTranscriptCache } from './provider-history-transcript-cache';

const file = (filePath: string, size = 10, mtimeMs = 1): HistoryFileIdentity => ({
  filePath,
  size,
  mtimeMs,
  ino: 7,
});
const transcript = (text: string): ChatMessage[] => [
  { id: text, source: 'user', text, timestamp: '2026-11-09T00:00:00Z', order: 0 },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('ProviderHistoryTranscriptCache', () => {
  it('serves only the exact file identity it stored and drops a changed file', () => {
    const cache = new ProviderHistoryTranscriptCache();
    cache.set('a', file('/a'), transcript('a'), 's');
    expect(cache.get('a', file('/a'), 's')?.[0]?.text).toBe('a');
    for (const changed of [
      file('/a', 11),
      file('/a', 10, 2),
      { ...file('/a'), ino: 8 },
      file('/b'),
    ]) {
      const fresh = new ProviderHistoryTranscriptCache();
      fresh.set('a', file('/a'), transcript('a'), 's');
      expect(fresh.get('a', changed, 's')).toBeUndefined();
      expect(fresh.size).toBe(0);
    }
  });

  it('returns a copy so callers cannot change the stored transcript', () => {
    const cache = new ProviderHistoryTranscriptCache();
    const stored = transcript('a');
    cache.set('a', file('/a'), stored, 's');
    stored.push(...transcript('b'));
    cache.get('a', file('/a'), 's')?.pop();
    expect(cache.get('a', file('/a'), 's')?.map((message) => message.text)).toEqual(['a']);
  });

  it('evicts least recently used entries past the entry bound', () => {
    const cache = new ProviderHistoryTranscriptCache({ maxEntries: 2 });
    cache.set('a', file('/a'), transcript('a'), 's');
    cache.set('b', file('/b'), transcript('b'), 's');
    cache.get('a', file('/a'), 's');
    cache.set('c', file('/c'), transcript('c'), 's');
    expect(cache.get('b', file('/b'), 's')).toBeUndefined();
    expect(cache.get('a', file('/a'), 's')).toBeDefined();
    expect(cache.get('c', file('/c'), 's')).toBeDefined();
  });

  it('bounds the summed file-size estimates and skips a file larger than the bound', () => {
    const cache = new ProviderHistoryTranscriptCache({ maxBytes: 100 });
    cache.set('a', file('/a', 60), transcript('a'), 's');
    cache.set('b', file('/b', 60), transcript('b'), 's');
    expect(cache.get('a', file('/a', 60), 's')).toBeUndefined();
    expect(cache.get('b', file('/b', 60), 's')).toBeDefined();
    cache.set('huge', file('/huge', 101), transcript('huge'), 's');
    expect(cache.get('huge', file('/huge', 101), 's')).toBeUndefined();
    expect(cache.get('b', file('/b', 60), 's')).toBeDefined();
  });

  it('keeps entries while their session store is live and expires them a TTL after release', async () => {
    vi.useFakeTimers();
    const cache = new ProviderHistoryTranscriptCache({ ttlMs: 1000 });
    cache.set('a', file('/a'), transcript('a'), 'viewed');
    cache.set('b', file('/b'), transcript('b'), 'other');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cache.size).toBe(2);

    cache.release('viewed');
    await vi.advanceTimersByTimeAsync(999);
    expect(cache.size).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.size).toBe(1);
    expect(cache.get('b', file('/b'), 'other')).toBeDefined();
  });

  it('holds a released entry again when it is reopened within the TTL', async () => {
    vi.useFakeTimers();
    const cache = new ProviderHistoryTranscriptCache({ ttlMs: 1000 });
    cache.set('a', file('/a'), transcript('a'), 's');
    cache.release('s');
    await vi.advanceTimersByTimeAsync(500);
    expect(cache.get('a', file('/a'), 's')).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cache.size).toBe(1);

    // The reopened entry is released again and starts its time to live again.
    cache.release('s');
    await vi.advanceTimersByTimeAsync(999);
    expect(cache.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.size).toBe(0);
  });

  it('forgets every entry of a permanently deleted session', () => {
    const cache = new ProviderHistoryTranscriptCache();
    cache.set('a', file('/a'), transcript('a'), 'deleted');
    cache.set('b', file('/b'), transcript('b'), 'kept');
    cache.release('deleted');
    cache.forget('deleted');
    expect(cache.size).toBe(1);
    expect(cache.get('b', file('/b'), 'kept')).toBeDefined();
  });
});
