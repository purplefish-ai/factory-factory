import { describe, expect, it } from 'vitest';
import { createDefaultApplicationDependencies } from '@/backend/app-context';
import {
  PR_DISPATCH_INVALIDATED,
  PR_SNAPSHOT_UPDATED,
  prSnapshotService,
} from '@/backend/services/github';
import {
  RATCHET_DISPATCH_CHANGED,
  RATCHET_STATE_CHANGED,
  RATCHET_TOGGLED,
  ratchetService,
} from '@/backend/services/ratchet';
import { RUN_SCRIPT_STATUS_CHANGED, runScriptStateMachine } from '@/backend/services/run-script';
import { sessionDomainService } from '@/backend/services/session';
import {
  WORKSPACE_STATE_CHANGED,
  workspaceActivityService,
  workspaceStateMachine,
} from '@/backend/services/workspace';

describe('event collector listener lifecycle', () => {
  it('restores every real EventEmitter listener count after stop', () => {
    const sources = [
      [workspaceStateMachine, WORKSPACE_STATE_CHANGED],
      [prSnapshotService, PR_SNAPSHOT_UPDATED],
      [prSnapshotService, PR_DISPATCH_INVALIDATED],
      [ratchetService, RATCHET_STATE_CHANGED],
      [ratchetService, RATCHET_TOGGLED],
      [ratchetService, RATCHET_DISPATCH_CHANGED],
      [runScriptStateMachine, RUN_SCRIPT_STATUS_CHANGED],
      [workspaceActivityService, 'workspace_active'],
      [workspaceActivityService, 'workspace_idle'],
      [workspaceActivityService, 'session_activity_changed'],
      [sessionDomainService, 'pending_request_changed'],
      [sessionDomainService, 'runtime_changed'],
    ] as const;
    const baseline = sources.map(([emitter, event]) => emitter.listenerCount(event));
    const collector = createDefaultApplicationDependencies().lifecycle.eventCollector;

    collector.start();
    expect(sources.map(([emitter, event]) => emitter.listenerCount(event))).toEqual(
      baseline.map((count) => count + 1)
    );

    collector.start();
    expect(sources.map(([emitter, event]) => emitter.listenerCount(event))).toEqual(
      baseline.map((count) => count + 1)
    );

    collector.stop();
    expect(sources.map(([emitter, event]) => emitter.listenerCount(event))).toEqual(baseline);
  });
});
