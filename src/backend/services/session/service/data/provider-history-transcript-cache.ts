import {
  type HistoryFileIdentity,
  isSameHistoryFile,
} from '@/backend/services/session/service/data/session-history-file';
import type { ChatMessage } from '@/shared/acp-protocol';

const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_TTL_MS = 5 * 60_000;

export interface ProviderHistoryTranscriptCacheOptions {
  maxEntries?: number;
  /** Bound on the summed byte estimates, which are the history files' sizes. */
  maxBytes?: number;
  /** How long an entry outlives the in-memory store of the session that used it. */
  ttlMs?: number;
  now?: () => number;
}

type Entry = {
  file: HistoryFileIdentity;
  transcript: ChatMessage[];
  bytes: number;
  sessionId: string;
  /** Held while that session's store may hold the transcript; the TTL starts on release. */
  held: boolean;
  expiresAt: number;
};

/**
 * Projected provider transcripts, keyed by session and provider history file and
 * valid only for the exact file identity (path, size, mtime, inode) they were
 * read from. A changed file can never be served stale: lookups compare
 * identities and drop a mismatched entry. It holds pure file projections, never
 * session store state, so clearing a store keeps its own preservation rules.
 * The hydrator copies each entry before a store receives it, because stores may
 * reassign an entry's top-level fields in place.
 *
 * Bounded by entry count and by estimated bytes (least recently used first),
 * and by a TTL that starts once the session's store is cleared.
 */
export class ProviderHistoryTranscriptCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private totalBytes = 0;
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;
  private sweepAt = Number.POSITIVE_INFINITY;

  constructor(options: ProviderHistoryTranscriptCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Returns a copy of the transcript only when `file` matches the stored identity. */
  get(key: string, file: HistoryFileIdentity, sessionId: string): ChatMessage[] | undefined {
    this.sweep();
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (!isSameHistoryFile(entry.file, file)) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.sessionId = sessionId;
    entry.held = true;
    entry.expiresAt = Number.POSITIVE_INFINITY;
    return [...entry.transcript];
  }

  set(
    key: string,
    file: HistoryFileIdentity,
    transcript: readonly ChatMessage[],
    sessionId: string
  ): void {
    this.sweep();
    this.delete(key);
    const bytes = file.size;
    if (bytes > this.maxBytes || this.maxEntries <= 0) {
      return;
    }
    this.entries.set(key, {
      file,
      transcript: [...transcript],
      bytes,
      sessionId,
      held: true,
      expiresAt: Number.POSITIVE_INFINITY,
    });
    this.totalBytes += bytes;
    for (const [oldestKey] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) {
        break;
      }
      this.delete(oldestKey);
    }
  }

  /** The session's in-memory store was cleared: start its entries' TTL. */
  release(sessionId: string): void {
    const expiresAt = this.now() + this.ttlMs;
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId && entry.held) {
        entry.held = false;
        entry.expiresAt = expiresAt;
      }
    }
    this.sweep();
  }

  /** The session was permanently deleted. */
  forget(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        this.delete(key);
      }
    }
    this.sweep();
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
    this.sweep();
  }

  get size(): number {
    return this.entries.size;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
    }
  }

  /** Drop expired entries and keep one unref'd timer for the next expiry. */
  private sweep(): void {
    const now = this.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.delete(key);
      } else {
        nextExpiry = Math.min(nextExpiry, entry.expiresAt);
      }
    }
    if (nextExpiry === this.sweepAt) {
      return;
    }
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.sweepAt = nextExpiry;
    if (Number.isFinite(nextExpiry)) {
      this.sweepTimer = setTimeout(
        () => {
          this.sweepTimer = undefined;
          this.sweepAt = Number.POSITIVE_INFINITY;
          this.sweep();
        },
        Math.max(0, nextExpiry - now)
      );
      this.sweepTimer.unref();
    }
  }
}

export const providerHistoryTranscriptCache = new ProviderHistoryTranscriptCache();
