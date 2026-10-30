import { describe, expect, it } from 'vitest';
import { AcpNativeSessionTracker } from './acp-native-session-tracker';

function update(sessionId: string, value: Record<string, unknown>) {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } };
}
function spawn(tracker: AcpNativeSessionTracker, parent = 'root', id = 'child') {
  tracker.onRawMessage(
    update(parent, {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: id,
      name: 'Researcher',
      capabilities: {},
    })
  );
}
function text(tracker: AcpNativeSessionTracker, id: string, role: 'agent', value: string) {
  tracker.onRawMessage(
    update(id, {
      sessionUpdate: `${role}_message_chunk`,
      content: { type: 'text', text: value },
    })
  );
}

describe('sub-agent replay timestamps', () => {
  it('does not date historical lifecycle or transcript activity at workspace reopen time', () => {
    const tracker = new AcpNativeSessionTracker();
    tracker.beginHistoryReplay();
    spawn(tracker, 'root', 'finished');
    text(tracker, 'finished', 'agent', 'Historical answer');
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: 'finished',
        state: 'completed',
      })
    );
    spawn(tracker, 'root', 'unfinished');
    tracker.completeHistoryReplay();

    expect(tracker.list({ limit: 10 }).subagents).toMatchObject([
      {
        id: 'finished',
        status: 'completed',
        createdAt: null,
        updatedAt: null,
        completedAt: null,
        resultPreview: 'Historical answer',
      },
      {
        id: 'unfinished',
        status: 'interrupted',
        createdAt: null,
        updatedAt: null,
        completedAt: null,
      },
    ]);
    expect(tracker.getBackgroundWork().runningSubagents).toBe(0);
  });

  it('still dates new lifecycle activity after replay completes', () => {
    const tracker = new AcpNativeSessionTracker();
    tracker.beginHistoryReplay();
    tracker.completeHistoryReplay();
    spawn(tracker);
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: 'child',
        state: 'completed',
      })
    );
    expect(tracker.list({ limit: 10 }).subagents[0]).toMatchObject({
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      completedAt: expect.any(String),
    });
  });
});
