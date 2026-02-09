import type { SessionRuntimeState } from '@/shared/session-runtime';
import type { SessionStore } from './session-store.types';

export class SessionRuntimeMachine {
  constructor(
    private readonly emitRuntimeDelta: (sessionId: string, runtime: SessionRuntimeState) => void,
    private readonly nowIso: () => string
  ) {}

  markRuntime(
    store: SessionStore,
    updates: Pick<SessionRuntimeState, 'phase' | 'processState' | 'activity'> & {
      lastExit?: SessionRuntimeState['lastExit'];
      updatedAt?: string;
    },
    options?: { emitDelta?: boolean; replace?: boolean }
  ): void {
    if (options?.replace) {
      store.runtime = {
        phase: updates.phase,
        processState: updates.processState,
        activity: updates.activity,
        ...(Object.hasOwn(updates, 'lastExit') ? { lastExit: updates.lastExit } : {}),
        updatedAt: updates.updatedAt ?? this.nowIso(),
      };

      if (options?.emitDelta !== false) {
        this.emitRuntimeDelta(store.sessionId, store.runtime);
      }
      return;
    }

    const hasExplicitLastExit = Object.hasOwn(updates, 'lastExit');
    store.runtime = {
      ...store.runtime,
      phase: updates.phase,
      processState: updates.processState,
      activity: updates.activity,
      ...(hasExplicitLastExit ? { lastExit: updates.lastExit } : { lastExit: undefined }),
      updatedAt: updates.updatedAt ?? this.nowIso(),
    };

    if (options?.emitDelta !== false) {
      this.emitRuntimeDelta(store.sessionId, store.runtime);
    }
  }
}
