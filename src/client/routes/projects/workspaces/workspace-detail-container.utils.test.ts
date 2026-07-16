import { describe, expect, it } from 'vitest';
import type { WorkspaceSessionRuntimeSummary } from '@/components/workspace/session-tab-runtime';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import {
  buildSessionSummariesById,
  hasUserMessageWithoutAgentMessage,
  type SessionForRuntimeOverlay,
} from './workspace-detail-container.utils';

describe('workspace detail container utils', () => {
  it('returns true when the transcript has a user message and no agent message', () => {
    expect(hasUserMessageWithoutAgentMessage([{ source: 'user' }])).toBe(true);
  });

  it('returns false when the transcript has no user message', () => {
    expect(hasUserMessageWithoutAgentMessage([])).toBe(false);
  });

  it('returns false when any agent message is present', () => {
    expect(hasUserMessageWithoutAgentMessage([{ source: 'user' }, { source: 'agent' }])).toBe(
      false
    );
  });

  it('stops scanning once an agent message makes the result false', () => {
    const laterMessage = {
      get source(): 'user' | 'agent' {
        throw new Error('later messages should not be inspected');
      },
    };

    expect(hasUserMessageWithoutAgentMessage([{ source: 'agent' }, laterMessage])).toBe(false);
  });
});

describe('buildSessionSummariesById', () => {
  function makeSummary(
    overrides: Partial<WorkspaceSessionRuntimeSummary> = {}
  ): WorkspaceSessionRuntimeSummary {
    return {
      sessionId: 'session-1',
      name: 'Snapshot name',
      workflow: 'followup',
      model: 'claude-sonnet-5',
      provider: 'CLAUDE',
      persistedStatus: 'RUNNING',
      runtimePhase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      updatedAt: '2026-07-16T10:00:00.000Z',
      lastExit: null,
      errorMessage: null,
      ...overrides,
    };
  }

  function makeSession(
    overrides: Partial<SessionForRuntimeOverlay> = {}
  ): SessionForRuntimeOverlay {
    return {
      id: 'session-1',
      name: 'DB name',
      workflow: 'followup',
      model: 'claude-sonnet-5',
      provider: 'CLAUDE',
      status: 'RUNNING',
      ...overrides,
    };
  }

  function makeLiveRuntime(overrides: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
    return {
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: '2026-07-16T11:00:00.000Z',
      ...overrides,
    };
  }

  it('returns snapshot summaries as the base map', () => {
    const result = buildSessionSummariesById({
      workspaceSummaries: [makeSummary(), makeSummary({ sessionId: 'session-2' })],
      sessions: [makeSession()],
      selectedSessionId: null,
      liveRuntime: makeLiveRuntime(),
      runtimeSessionId: null,
      chatConnected: true,
    });

    expect(result.size).toBe(2);
    expect(result.get('session-1')).toEqual(makeSummary());
  });

  it('overlays live runtime on the selected session while connected', () => {
    const result = buildSessionSummariesById({
      workspaceSummaries: [makeSummary()],
      sessions: [makeSession()],
      selectedSessionId: 'session-1',
      liveRuntime: makeLiveRuntime({ phase: 'stopping', activity: 'IDLE' }),
      runtimeSessionId: 'session-1',
      chatConnected: true,
    });

    const merged = result.get('session-1');
    expect(merged?.runtimePhase).toBe('stopping');
    expect(merged?.activity).toBe('IDLE');
    expect(merged?.updatedAt).toBe('2026-07-16T11:00:00.000Z');
    // Metadata still comes from the snapshot summary.
    expect(merged?.name).toBe('Snapshot name');
    expect(merged?.persistedStatus).toBe('RUNNING');
  });

  it('does not overlay while the runtime still describes a previous session', () => {
    // During a session switch the reducer holds the old session's runtime for
    // a render or two; overlaying it would paint the wrong session's status
    // onto the newly selected tab.
    const result = buildSessionSummariesById({
      workspaceSummaries: [makeSummary(), makeSummary({ sessionId: 'session-2' })],
      sessions: [makeSession(), makeSession({ id: 'session-2' })],
      selectedSessionId: 'session-2',
      liveRuntime: makeLiveRuntime({ phase: 'running', activity: 'WORKING' }),
      runtimeSessionId: 'session-1',
      chatConnected: true,
    });

    expect(result.get('session-2')).toEqual(makeSummary({ sessionId: 'session-2' }));
  });

  it('does not overlay before the first hydration', () => {
    const result = buildSessionSummariesById({
      workspaceSummaries: [makeSummary()],
      sessions: [makeSession()],
      selectedSessionId: 'session-1',
      liveRuntime: makeLiveRuntime({ phase: 'running' }),
      runtimeSessionId: null,
      chatConnected: true,
    });

    expect(result.get('session-1')).toEqual(makeSummary());
  });

  it('does not overlay when the chat socket is disconnected', () => {
    const result = buildSessionSummariesById({
      workspaceSummaries: [makeSummary()],
      sessions: [makeSession()],
      selectedSessionId: 'session-1',
      liveRuntime: makeLiveRuntime({ phase: 'stopping' }),
      runtimeSessionId: 'session-1',
      chatConnected: false,
    });

    expect(result.get('session-1')).toEqual(makeSummary());
  });

  it('does not overlay sessions other than the selected one', () => {
    const result = buildSessionSummariesById({
      workspaceSummaries: [makeSummary(), makeSummary({ sessionId: 'session-2' })],
      sessions: [makeSession(), makeSession({ id: 'session-2' })],
      selectedSessionId: 'session-1',
      liveRuntime: makeLiveRuntime({ phase: 'error' }),
      runtimeSessionId: 'session-1',
      chatConnected: true,
    });

    expect(result.get('session-2')).toEqual(makeSummary({ sessionId: 'session-2' }));
  });

  it('ignores a selected session that no longer exists in the session list', () => {
    const result = buildSessionSummariesById({
      workspaceSummaries: [],
      sessions: [makeSession()],
      selectedSessionId: 'session-gone',
      liveRuntime: makeLiveRuntime(),
      runtimeSessionId: 'session-gone',
      chatConnected: true,
    });

    expect(result.size).toBe(0);
  });

  it('creates an entry from the session row when no snapshot summary exists yet', () => {
    const result = buildSessionSummariesById({
      workspaceSummaries: [],
      sessions: [makeSession({ id: 'session-new', name: 'Fresh chat', status: 'IDLE' })],
      selectedSessionId: 'session-new',
      liveRuntime: makeLiveRuntime({ phase: 'starting' }),
      runtimeSessionId: 'session-new',
      chatConnected: true,
    });

    const created = result.get('session-new');
    expect(created?.name).toBe('Fresh chat');
    expect(created?.persistedStatus).toBe('IDLE');
    expect(created?.runtimePhase).toBe('starting');
    expect(created?.lastExit).toBeNull();
  });
});
