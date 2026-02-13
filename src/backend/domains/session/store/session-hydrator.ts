import { SessionManager } from '@/backend/domains/session/claude/session';
import { buildHydrateKey, type HydrateKeyInput } from './session-hydrate-key';
import type { SessionStore } from './session-store.types';
import {
  buildTranscriptFromHistory,
  messageSort,
  normalizeTranscript,
  setNextOrderFromTranscript,
} from './session-transcript';

export class SessionHydrator {
  constructor(
    private readonly nowIso: () => string,
    private readonly onParityTrace: (sessionId: string, data: Record<string, unknown>) => void
  ) {}

  async ensureHydrated(store: SessionStore, options: HydrateKeyInput): Promise<void> {
    const hydrateKey = buildHydrateKey(options);
    if (store.initialized && store.hydratedKey === hydrateKey) {
      return;
    }

    if (store.hydratePromise && store.hydratingKey === hydrateKey) {
      await store.hydratePromise;
      return;
    }

    const generation = store.hydrateGeneration + 1;
    store.hydrateGeneration = generation;
    store.hydratingKey = hydrateKey;

    const hydratePromise = (async () => {
      if (options.claudeSessionId && options.claudeProjectPath) {
        const history = await SessionManager.getHistoryFromProjectPath(
          options.claudeSessionId,
          options.claudeProjectPath
        );
        const transcript = buildTranscriptFromHistory(history);
        transcript.sort(messageSort);
        this.onParityTrace(store.sessionId, {
          path: 'jsonl_hydrate',
          claudeSessionId: options.claudeSessionId,
          claudeProjectPath: options.claudeProjectPath,
          historyCount: history.length,
          transcriptCount: transcript.length,
          transcript: normalizeTranscript(transcript),
        });

        if (store.hydrateGeneration !== generation) {
          return;
        }

        store.transcript = transcript;
      } else if (store.hydrateGeneration !== generation) {
        // No JSONL source (ACP or no project path) — preserve existing in-memory transcript
        return;
      }

      setNextOrderFromTranscript(store);
      store.initialized = true;
      store.hydratedKey = hydrateKey;
      store.lastHydratedAt = this.nowIso();
    })().finally(() => {
      if (store.hydrateGeneration === generation) {
        store.hydratePromise = null;
        store.hydratingKey = null;
      }
    });

    store.hydratePromise = hydratePromise;
    await hydratePromise;
  }
}
