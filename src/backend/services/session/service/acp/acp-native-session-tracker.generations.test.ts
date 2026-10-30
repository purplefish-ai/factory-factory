import { describe, expect, it, vi } from 'vitest';
import { AcpNativeSessionTracker } from './acp-native-session-tracker';

const childId = '01a18e56-beb7-7651-be0b-e6bb817ee36f';
const resumedId = `${childId}:generation:2`;
function send(
  tracker: AcpNativeSessionTracker,
  sessionId: string,
  update: Record<string, unknown>
) {
  tracker.onRawMessage({ method: 'session/update', params: { sessionId, update } });
}
function spawn(tracker: AcpNativeSessionTracker, id: string) {
  send(tracker, 'root', {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: id,
    name: 'Triage',
  });
}
function reply(tracker: AcpNativeSessionTracker, id: string, text: string) {
  send(tracker, id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
}
function finish(tracker: AcpNativeSessionTracker, id: string) {
  send(tracker, 'root', {
    sessionUpdate: 'subagent_state_update',
    subagentSessionId: id,
    state: 'completed',
  });
}

describe('Codex resumed subagent transcripts', () => {
  it.each([false, true])(
    'retains the whole conversation across generations (replay=%s)',
    (replay) => {
      const changed = vi.fn();
      const tracker = new AcpNativeSessionTracker({
        groupCodexGenerations: true,
        onSubagentsChanged: changed,
      });
      tracker.setRootSessionId('root');
      if (replay) {
        tracker.beginHistoryReplay();
      }
      spawn(tracker, childId);
      reply(tracker, childId, 'Original work');
      finish(tracker, childId);
      spawn(tracker, resumedId);
      reply(tracker, resumedId, 'Follow-up work');
      // Late completion from an old generation must not finish the resumed agent.
      finish(tracker, childId);
      expect(tracker.list({ limit: 10 }).subagents).toMatchObject([
        { id: childId, status: 'running', completedAt: null },
      ]);
      expect(tracker.list({ limit: 10 }).subagents).toHaveLength(1);
      expect(tracker.ownsSession(resumedId)).toBe(true);
      const latest = tracker.read({ subagentId: childId, limit: 1 });
      expect(latest.updates).toMatchObject([{ content: { text: 'Follow-up work' } }]);
      expect(latest.nextCursor).toBe('1');
      expect(
        tracker.read({ subagentId: childId, limit: 1, cursor: latest.nextCursor }).updates
      ).toMatchObject([{ content: { text: 'Original work' } }]);
      // Previously saved generation tabs remain readable.
      expect(tracker.read({ subagentId: resumedId, limit: 10 }).updates).toHaveLength(2);
      expect(changed).toHaveBeenLastCalledWith({
        sessionId: 'root',
        subagentId: childId,
        change: 'updated',
      });
      finish(tracker, resumedId);
      if (replay) {
        tracker.completeHistoryReplay();
      }
      expect(tracker.list({ limit: 10 }).subagents).toMatchObject([
        { id: childId, status: 'completed' },
      ]);
      expect(tracker.getBackgroundWork().runningSubagents).toBe(0);
    }
  );

  it('keeps live output after the adapter resets its generation counter on history load', () => {
    const tracker = new AcpNativeSessionTracker({ groupCodexGenerations: true });
    tracker.setRootSessionId('root');
    tracker.beginHistoryReplay();
    spawn(tracker, childId);
    reply(tracker, childId, 'Original work');
    finish(tracker, childId);
    spawn(tracker, resumedId);
    reply(tracker, resumedId, 'Historical follow-up');
    finish(tracker, resumedId);
    tracker.completeHistoryReplay();
    // The adapter builds a fresh live router, so its native IDs start over.
    spawn(tracker, childId);
    reply(tracker, childId, 'Live follow-up');
    expect(tracker.list({ limit: 10 }).subagents).toMatchObject([
      { id: childId, generation: 3, status: 'running' },
    ]);
    finish(tracker, childId);
    spawn(tracker, resumedId);
    reply(tracker, resumedId, 'Next live follow-up');
    expect(tracker.list({ limit: 10 }).subagents).toMatchObject([
      { id: childId, generation: 4, status: 'running' },
    ]);
    expect(
      tracker
        .read({ subagentId: childId, limit: 10 })
        .updates.map((update) => 'content' in update && update.content)
    ).toEqual([
      { type: 'text', text: 'Original work' },
      { type: 'text', text: 'Historical follow-up' },
      { type: 'text', text: 'Live follow-up' },
      { type: 'text', text: 'Next live follow-up' },
    ]);
  });

  it('retains bounded turns across generations and expires evicted cursors', () => {
    const tracker = new AcpNativeSessionTracker({ groupCodexGenerations: true });
    for (let generation = 1; generation <= 102; generation += 1) {
      const id = generation === 1 ? childId : `${childId}:generation:${generation}`;
      spawn(tracker, id);
      reply(tracker, id, `Reply ${generation}`);
      finish(tracker, id);
    }
    const page = tracker.read({ subagentId: childId, limit: 100 });
    expect(page.updates).toHaveLength(100);
    expect(page.updates[0]).toMatchObject({ content: { text: 'Reply 3' } });
    expect(page.nextCursor).toBeNull();
    expect(() => tracker.read({ subagentId: childId, limit: 1, cursor: '1' })).toThrow('expired');
  });

  it('routes nested completion through the parent generation that spawned it', () => {
    const tracker = new AcpNativeSessionTracker({ groupCodexGenerations: true });
    spawn(tracker, childId);
    send(tracker, childId, {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'grandchild',
      name: 'Nested',
    });
    finish(tracker, childId);
    spawn(tracker, resumedId);
    send(tracker, childId, {
      sessionUpdate: 'subagent_state_update',
      subagentSessionId: 'grandchild',
      state: 'completed',
    });
    expect(tracker.list({ limit: 10 }).subagents).toMatchObject([
      { id: childId, status: 'running' },
      { id: 'grandchild', status: 'completed' },
    ]);
    expect(tracker.getBackgroundWork().runningSubagents).toBe(1);
  });

  it('keeps provider session identities separate without Codex generation grouping', () => {
    const tracker = new AcpNativeSessionTracker();
    spawn(tracker, childId);
    spawn(tracker, resumedId);
    expect(tracker.list({ limit: 10 }).subagents).toHaveLength(2);
  });
});
