import { beforeEach, describe, expect, it } from 'vitest';
import { sessionRuntimeStoreService } from './session-runtime-store.service';

describe('SessionRuntimeStoreService', () => {
  beforeEach(() => {
    sessionRuntimeStoreService.clearAllSessions();
  });

  it('marks start failure as error with stopped process state', () => {
    sessionRuntimeStoreService.markStarting('session-1');
    const runtime = sessionRuntimeStoreService.markError('session-1');

    expect(runtime.phase).toBe('error');
    expect(runtime.processState).toBe('stopped');
    expect(runtime.activity).toBe('IDLE');
  });
});
