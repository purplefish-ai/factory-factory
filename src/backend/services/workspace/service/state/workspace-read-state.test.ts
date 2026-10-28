import { afterEach, describe, expect, it } from 'vitest';
import { assembleWorkspaceDerivedState } from '@/backend/lib/workspace-derived-state';
import type { SessionSummary } from '@/shared/session-runtime';
import { deriveWorkspaceFlowState } from '@/shared/workspace-flow-state';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { WorkspaceSnapshotStore } from '../snapshot/workspace-snapshot-store.service';
import {
  deriveLastActivityAt,
  toWorkspaceDerivedStateInput,
  type WorkspaceDerivedStateSource,
} from './workspace-read-state';

const raw: WorkspaceDerivedStateSource = {
  status: 'READY',
  prUrl: null,
  prState: 'NONE',
  prCiStatus: 'UNKNOWN',
  ratchetState: 'IDLE',
  ratchetEnabled: false,
  hasHadSessions: true,
  hasMergeConflict: false,
  mode: 'STANDARD',
  autoIterationStatus: null,
};
const flowState = {
  phase: 'NO_PR',
  ciObservation: 'NOT_FETCHED',
  shouldAnimateRatchetButton: false,
} as const;
const idle: SessionSummary = {
  sessionId: 'session',
  name: null,
  workflow: null,
  model: null,
  persistedStatus: 'RUNNING',
  runtimePhase: 'idle',
  processState: 'alive',
  activity: 'IDLE',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastExit: null,
};

const stores: WorkspaceSnapshotStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.clear();
  }
});

describe('deriveLastActivityAt', () => {
  it('selects the latest agent or terminal timestamp and ignores invalid dates', () => {
    expect(
      deriveLastActivityAt({
        agentSessions: [{ updatedAt: new Date('invalid') }, { updatedAt: new Date('2026-01-02') }],
        terminalSessions: [{ updatedAt: new Date('2026-01-03') }],
      })
    ).toBe('2026-01-03T00:00:00.000Z');
    expect(
      deriveLastActivityAt({
        agentSessions: [{ updatedAt: new Date('2026-01-04') }],
        terminalSessions: [{ updatedAt: new Date('2026-01-03') }],
      })
    ).toBe('2026-01-04T00:00:00.000Z');
  });

  it.each([
    {},
    { agentSessions: null, terminalSessions: [] },
    {
      agentSessions: [{ updatedAt: new Date('invalid') }],
    },
  ])('returns null without a valid session timestamp: %j', (input) => {
    expect(deriveLastActivityAt(input)).toBeNull();
  });
});

describe('toWorkspaceDerivedStateInput', () => {
  it('preserves absent PR projections and explicit nulls', () => {
    const input = toWorkspaceDerivedStateInput(raw, {
      sessionSummaries: [],
      sessionIsWorking: false,
      pendingRequestType: null,
      flowState,
    });
    expect(input).toMatchObject({
      lifecycle: 'READY',
      prUrl: null,
      autoIterationStatus: null,
      pendingRequestType: null,
      prSummary: undefined,
      prMonitoring: undefined,
      dispatchStalled: false,
      hasSessionRuntimeError: false,
      isSessionStarting: false,
    });
  });

  it.each([
    { session: { ...idle, runtimePhase: 'starting' as const }, reason: 'STARTING_SESSION' },
    {
      session: { ...idle, runtimePhase: 'error' as const, errorMessage: 'crashed' },
      reason: 'SESSION_ERROR',
    },
  ])('retains runtime predicate precedence for $reason', ({ session, reason }) => {
    const input = toWorkspaceDerivedStateInput(raw, {
      sessionSummaries: [session],
      sessionIsWorking: false,
      pendingRequestType: null,
      flowState,
    });
    expect(
      assembleWorkspaceDerivedState(input, {
        deriveSidebarStatus: deriveWorkspaceSidebarStatus,
      }).statusReason.code
    ).toBe(reason);
  });

  it('retains pending requests ahead of runtime errors', () => {
    const input = toWorkspaceDerivedStateInput(raw, {
      sessionSummaries: [{ ...idle, runtimePhase: 'error', errorMessage: 'crashed' }],
      sessionIsWorking: false,
      pendingRequestType: 'permission_request',
      flowState,
    });
    expect(
      assembleWorkspaceDerivedState(input, {
        deriveSidebarStatus: deriveWorkspaceSidebarStatus,
      }).statusReason.code
    ).toBe('NEEDS_PERMISSION');
  });

  it('preserves supplied PR projections and paused monitoring', () => {
    const prSummary = {
      totalCount: 1,
      openCount: 1,
      hasNonterminal: true,
      state: 'OPEN',
      ciStatus: 'FAILURE',
      hasMergeConflict: true,
      ratchetState: 'IDLE',
    } as const;
    const prMonitoring = {
      enabled: true,
      deliveryMode: 'MAIN',
      recipientSessionId: 'session',
      bindingRevision: 2,
      pauseReason: 'DELIVERY_FAILED',
      pendingEventCount: 1,
    } as const;
    const input = toWorkspaceDerivedStateInput(
      {
        ...raw,
        prSummary,
        prMonitoring,
        prState: 'OPEN',
        ratchetEnabled: true,
        hasMergeConflict: true,
      },
      {
        sessionSummaries: [],
        sessionIsWorking: false,
        pendingRequestType: null,
        flowState: {
          phase: 'READY',
          ciObservation: 'CHECKS_FAILED',
          shouldAnimateRatchetButton: true,
        },
      }
    );
    expect(input).toMatchObject({ prSummary, prMonitoring, dispatchStalled: true });
    expect(
      assembleWorkspaceDerivedState(input, {
        deriveSidebarStatus: deriveWorkspaceSidebarStatus,
      })
    ).toMatchObject({
      isWorking: false,
      ratchetButtonAnimated: true,
      statusReason: { code: 'PR_DELIVERY_ERROR' },
    });
  });

  it.each([false, true])(
    'keeps HTTP-style and merged-store projections equivalent with busy=%s',
    (busy) => {
      const source: WorkspaceDerivedStateSource = {
        ...raw,
        mode: 'AUTO_ITERATION',
        autoIterationStatus: 'RUNNING',
        ratchetEnabled: true,
      };
      const http = assembleWorkspaceDerivedState(
        toWorkspaceDerivedStateInput(source, {
          sessionSummaries: [idle],
          sessionIsWorking: busy,
          pendingRequestType: null,
          flowState,
        }),
        { deriveSidebarStatus: deriveWorkspaceSidebarStatus }
      );
      const store = new WorkspaceSnapshotStore();
      stores.push(store);
      store.configure({
        deriveFlowState: (input) =>
          deriveWorkspaceFlowState({
            ...input,
            prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
          }),
        deriveSidebarStatus: deriveWorkspaceSidebarStatus,
      });
      store.upsert(
        'ws',
        {
          ...source,
          projectId: 'project',
          isWorking: busy,
          sessionSummaries: [idle],
          pendingRequestType: null,
        },
        'seed',
        100
      );
      // The later session observation wins, even while an intermediate update
      // contributes a newer workspace field and rejected session values.
      store.upsert('ws', { isWorking: busy, sessionSummaries: [idle] }, 'session', 300);
      store.upsert(
        'ws',
        {
          hasHadSessions: true,
          isWorking: !busy,
          sessionSummaries: [{ ...idle, runtimePhase: 'error', errorMessage: 'stale crash' }],
        },
        'partially stale',
        200
      );
      const entry = store.getByWorkspaceId('ws');
      expect(entry).toMatchObject(http);
      expect(http).toMatchObject({
        isWorking: busy,
        kanbanColumn: 'WORKING',
        sidebarStatus: { activityState: busy ? 'WORKING' : 'IDLE', ciState: 'NONE' },
        ratchetButtonAnimated: false,
        statusReason: { code: busy ? 'AGENT_WORKING' : 'AUTO_ITERATING' },
      });
      // Re-derivation keeps raw busy through a later PR-only update.
      store.upsert('ws', { prCiStatus: 'UNKNOWN' }, 'PR refresh', 400);
      expect(store.getByWorkspaceId('ws')).toMatchObject(http);
    }
  );
});
