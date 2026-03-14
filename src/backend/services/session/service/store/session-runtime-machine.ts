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
      errorMessage?: SessionRuntimeState['errorMessage'];
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
        ...(Object.hasOwn(updates, 'errorMessage') ? { errorMessage: updates.errorMessage } : {}),
        updatedAt: updates.updatedAt ?? this.nowIso(),
      };

      if (options?.emitDelta !== false) {
        this.emitRuntimeDelta(store.sessionId, store.runtime);
      }
      return;
    }

    const hasExplicitLastExit = Object.hasOwn(updates, 'lastExit');
    const hasExplicitErrorMessage = Object.hasOwn(updates, 'errorMessage');
    const {
      lastExit: _lastExit,
      errorMessage: _errorMessage,
      ...runtimeWithoutTransientFields
    } = store.runtime;
    store.runtime = {
      ...runtimeWithoutTransientFields,
      phase: updates.phase,
      processState: updates.processState,
      activity: updates.activity,
      ...(hasExplicitLastExit ? { lastExit: updates.lastExit } : {}),
      ...(hasExplicitErrorMessage ? { errorMessage: updates.errorMessage } : {}),
      updatedAt: updates.updatedAt ?? this.nowIso(),
    };

    if (options?.emitDelta !== false) {
      this.emitRuntimeDelta(store.sessionId, store.runtime);
    }
  }
}
