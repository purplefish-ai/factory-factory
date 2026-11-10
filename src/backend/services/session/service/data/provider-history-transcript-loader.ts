import type { CodexRuntimeContext } from '@/backend/services/codex-accounts';
import { codexSessionHistoryLoaderService } from '@/backend/services/session/service/data/codex-session-history-loader.service';
import type {
  HistoryFileIdentity,
  HistoryLoadResult,
} from '@/backend/services/session/service/data/session-history-file';
import { claudeSessionHistoryLoaderService } from '@/backend/services/session/service/data/session-history-loader.service';
import { buildTranscriptFromHistoryCooperatively } from '@/backend/services/session/service/store/session-transcript';
import type { ChatMessage } from '@/shared/acp-protocol';
import { providerHistoryTranscriptCache as cache } from './provider-history-transcript-cache';

export type ProviderHistorySession = {
  provider: 'CLAUDE' | 'CODEX';
  codexAccountId?: string | null;
  codexAccountContext?: CodexRuntimeContext;
  providerSessionId: string | null;
  providerMetadata: unknown;
  workspace: { worktreePath: string | null };
};

export type ProviderHistoryTranscriptResult =
  | {
      status: 'loaded';
      /** Shared by every caller of one load; callers must not mutate it. */
      transcript: readonly ChatMessage[];
      filePath: string;
      source: 'cache' | 'file';
    }
  | Exclude<HistoryLoadResult, { status: 'loaded' }>
  | { status: 'cancelled' };

type Consumer = { isCurrent: () => boolean };
type Flight = {
  consumers: Set<Consumer>;
  /** Latched once every consumer is stale; later callers start a new flight. */
  cancelled: boolean;
  promise: Promise<ProviderHistoryTranscriptResult>;
};

const flights = new Map<string, Flight>();
const CANCELLED = { status: 'cancelled' } as const;

/**
 * Read and project one provider history, shared by every concurrent caller
 * for the same session and provider identity (passive loads, startup and
 * workflow finalization alike), reusing a cached projection of an unchanged
 * file. Each caller applies the result through its own domain and fences. The
 * read stops only when all of its callers are stale; a caller that is still
 * current when a shared read was cancelled starts afresh.
 */
export async function loadProviderHistoryTranscript(
  sessionId: string,
  dbSession: ProviderHistorySession,
  providerSessionId: string,
  isCurrent: () => boolean
): Promise<ProviderHistoryTranscriptResult> {
  const key = JSON.stringify([
    sessionId,
    dbSession.provider,
    providerSessionId,
    dbSession.workspace.worktreePath ?? '',
    dbSession.codexAccountId ?? null,
  ]);
  for (;;) {
    const consumer: Consumer = { isCurrent };
    const flight = joinFlight(key, consumer, (sharedIsCurrent) =>
      readProviderHistoryTranscript(sessionId, dbSession, providerSessionId, sharedIsCurrent)
    );
    let result: ProviderHistoryTranscriptResult;
    try {
      result = await flight.promise;
    } finally {
      flight.consumers.delete(consumer);
    }
    if (result.status !== 'cancelled' || !isCurrent()) {
      return result;
    }
  }
}

function joinFlight(
  key: string,
  consumer: Consumer,
  run: (isCurrent: () => boolean) => Promise<ProviderHistoryTranscriptResult>
): Flight {
  const existing = flights.get(key);
  // A stale consumer means a stop, reset or rollover happened after this read
  // began; the file may have changed since, so start a fresh read instead.
  if (existing && !existing.cancelled && !hasStaleConsumer(existing.consumers)) {
    existing.consumers.add(consumer);
    return existing;
  }
  const consumers = new Set([consumer]);
  const flight: Flight = { consumers, cancelled: false, promise: Promise.resolve(CANCELLED) };
  // Checked per history line, so it avoids allocating.
  const sharedIsCurrent = () => {
    if (!(flight.cancelled || hasCurrentConsumer(consumers))) {
      flight.cancelled = true;
    }
    return !flight.cancelled;
  };
  flight.promise = run(sharedIsCurrent).finally(() => {
    if (flights.get(key) === flight) {
      flights.delete(key);
    }
  });
  flights.set(key, flight);
  return flight;
}

function hasCurrentConsumer(consumers: Set<Consumer>): boolean {
  for (const consumer of consumers) {
    if (consumer.isCurrent()) {
      return true;
    }
  }
  return false;
}

function hasStaleConsumer(consumers: Set<Consumer>): boolean {
  for (const consumer of consumers) {
    if (!consumer.isCurrent()) {
      return true;
    }
  }
  return false;
}

async function readProviderHistoryTranscript(
  sessionId: string,
  dbSession: ProviderHistorySession,
  providerSessionId: string,
  isCurrent: () => boolean
): Promise<ProviderHistoryTranscriptResult> {
  const cacheKey = (file: HistoryFileIdentity) =>
    JSON.stringify([dbSession.provider, providerSessionId, file.filePath]);
  const input = {
    providerSessionId,
    workingDir: dbSession.workspace.worktreePath ?? '',
    isCurrent,
    reuse: (file: HistoryFileIdentity) => cache.get(cacheKey(file), file, sessionId),
  };
  const loaded =
    dbSession.provider === 'CLAUDE'
      ? await claudeSessionHistoryLoaderService.loadSessionHistory(input)
      : await codexSessionHistoryLoaderService.loadSessionHistory({
          ...input,
          ...(dbSession.codexAccountId ? { codexAccountId: dbSession.codexAccountId } : {}),
          ...(dbSession.codexAccountContext
            ? { codexAccountContext: dbSession.codexAccountContext }
            : {}),
        });
  // A cancelled read ends early without an error, so its history may be partial.
  if (!isCurrent()) {
    return CANCELLED;
  }
  if (loaded.status === 'reused') {
    return {
      status: 'loaded',
      transcript: loaded.value,
      filePath: loaded.filePath,
      source: 'cache',
    };
  }
  if (loaded.status !== 'loaded') {
    return loaded;
  }
  const transcript = await buildTranscriptFromHistoryCooperatively(loaded.history, isCurrent);
  if (!(transcript && isCurrent())) {
    return CANCELLED;
  }
  if (loaded.file) {
    cache.set(cacheKey(loaded.file), loaded.file, transcript, sessionId);
  }
  return { status: 'loaded', transcript, filePath: loaded.filePath, source: 'file' };
}
