import { SessionManager } from '@/backend/claude';
import type { ChatMessage } from '@/shared/claude';
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

  async ensureHydrated(
    store: SessionStore,
    options: { claudeSessionId: string | null; claudeProjectPath: string | null }
  ): Promise<void> {
    const hydrateKey = `${options.claudeSessionId ?? 'none'}::${options.claudeProjectPath ?? 'none'}`;
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
      let transcript: ChatMessage[] = [];

      if (options.claudeSessionId && options.claudeProjectPath) {
        const history = await SessionManager.getHistoryFromProjectPath(
          options.claudeSessionId,
          options.claudeProjectPath
        );
        transcript = buildTranscriptFromHistory(history);
        transcript.sort(messageSort);
        this.onParityTrace(store.sessionId, {
          path: 'jsonl_hydrate',
          claudeSessionId: options.claudeSessionId,
          claudeProjectPath: options.claudeProjectPath,
          historyCount: history.length,
          transcriptCount: transcript.length,
          transcript: normalizeTranscript(transcript),
        });
      }

      if (store.hydrateGeneration !== generation) {
        return;
      }

      store.transcript = transcript;
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
