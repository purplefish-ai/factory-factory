import { describe, expect, it, vi } from 'vitest';
import { AcpNativeSessionTracker } from './acp-native-session-tracker';
import { createNormalizedAcpReadableStream } from './acp-stream-normalizer';

function update(sessionId: string, value: Record<string, unknown>) {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } };
}
function spawn(tracker: AcpNativeSessionTracker, parent = 'root', id = 'child') {
  return tracker.onRawMessage(
    update(parent, {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: id,
      name: 'Researcher',
      task: 'Inspect code',
      capabilities: {},
    })
  );
}
function text(
  tracker: AcpNativeSessionTracker,
  sessionId: string,
  role: 'user' | 'agent',
  value: string,
  messageId?: string
) {
  return tracker.onRawMessage(
    update(sessionId, {
      sessionUpdate: `${role}_message_chunk`,
      content: { type: 'text', text: value },
      messageId,
    })
  );
}

describe('AcpNativeSessionTracker', () => {
  it('captures negotiation before SDK validation and consumes native child output only', () => {
    // Catches unsupported draft events reaching SDK validation or child output reaching parent chat.
    const changed = vi.fn();
    const tracker = new AcpNativeSessionTracker({ onSubagentsChanged: changed });
    tracker.setRootSessionId('root');
    tracker.onRawMessage({
      jsonrpc: '2.0',
      id: 1,
      result: {
        agentCapabilities: { sessionCapabilities: { subagents: {} } },
      },
    });
    expect(tracker.isAvailable()).toBe(true);
    expect(spawn(tracker)).toBe(true);
    expect(text(tracker, 'child', 'agent', 'Private research')).toBe(true);
    expect(text(tracker, 'root', 'agent', 'Parent response')).toBe(false);
    expect(tracker.ownsSession('child')).toBe(true);
    expect(tracker.ownsSession('unrelated')).toBe(false);
    expect(tracker.list({ limit: 10 })).toMatchObject({
      subagents: [
        { id: 'child', name: 'Researcher', status: 'running', latestActivity: 'Private research' },
      ],
      nextCursor: null,
    });
    expect(changed).toHaveBeenCalledWith({
      sessionId: 'root',
      subagentId: 'child',
      change: 'created',
    });
  });

  it('reconstructs nested children without treating an orphan as completed', () => {
    // Catches root replay losing descendants or inventing successful results for disconnected work.
    const tracker = new AcpNativeSessionTracker();
    spawn(tracker);
    spawn(tracker, 'child', 'grandchild');
    tracker.onRawMessage(
      update('child', {
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: 'grandchild',
        state: 'disconnected',
      })
    );
    expect(tracker.list({ limit: 10 }).subagents).toMatchObject([
      { id: 'child', status: 'running' },
      { id: 'grandchild', status: 'interrupted' },
    ]);
    expect(tracker.read({ subagentId: 'grandchild', limit: 10 })).toEqual({
      projectionBoundary: 'turn',
      updates: [],
      nextCursor: null,
    });
  });

  it('shows Claude delegated prompts and replaces them with actual child replay when available', () => {
    // Catches losing Claude live user prompts or duplicating the prompt during provider replay.
    const tracker = new AcpNativeSessionTracker();
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: 'child',
        name: 'Worker',
        task: 'short description',
        prompt: 'Full delegated prompt',
        capabilities: {},
      })
    );
    expect(tracker.read({ subagentId: 'child', limit: 10 }).updates).toEqual([
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Full delegated prompt' },
      },
    ]);
    text(tracker, 'child', 'user', 'Full delegated prompt', 'actual-id');
    text(tracker, 'child', 'agent', 'Answer');
    expect(tracker.read({ subagentId: 'child', limit: 10 }).updates).toHaveLength(2);
  });

  it('pages child transcripts by whole turns and keeps cursors stable as live output arrives', () => {
    // Catches splitting tools/results across pages or an appended turn shifting an older cursor.
    const tracker = new AcpNativeSessionTracker();
    spawn(tracker);
    text(tracker, 'child', 'user', 'First', 'u1');
    text(tracker, 'child', 'agent', 'One');
    text(tracker, 'child', 'user', 'Second', 'u2');
    text(tracker, 'child', 'user', ' chunk', 'u2');
    tracker.onRawMessage(
      update('child', {
        sessionUpdate: 'tool_call',
        toolCallId: 'call',
        title: 'Read',
        status: 'pending',
      })
    );
    tracker.onRawMessage(
      update('child', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call',
        status: 'completed',
      })
    );
    const first = tracker.read({ subagentId: 'child', limit: 1 });
    expect(first.updates).toHaveLength(4);
    expect(first.updates[0]).toMatchObject({ content: { text: 'Second' } });
    expect(first.nextCursor).not.toBeNull();
    text(tracker, 'child', 'user', 'Third', 'u3');
    const older = tracker.read({ subagentId: 'child', limit: 1, cursor: first.nextCursor });
    expect(older.updates).toMatchObject([
      { content: { text: 'First' } },
      { content: { text: 'One' } },
    ]);
    expect(older.nextCursor).toBeNull();
  });

  it('keeps background activity until every child, goal and async task ends', () => {
    // Catches prompt completion or a single background task clearing other ongoing work.
    const active = vi.fn();
    const tracker = new AcpNativeSessionTracker({ onTaskStatusChanged: active });
    tracker.setRootSessionId('root');
    spawn(tracker);
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'session_info_update',
        _meta: { jetbrains: { air: { goal: { status: 'active' } } } },
      })
    );
    expect(
      tracker.onRawMessage(
        update('child', {
          sessionUpdate: 'async_task_spawned',
          asyncTaskId: 'shell',
          name: 'Build',
          taskType: 'shell',
          showInTranscript: false,
          canStop: true,
        })
      )
    ).toBe(true);
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: 'child',
        state: 'completed',
      })
    );
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'session_info_update',
        _meta: { jetbrains: { air: { goal: null } } },
      })
    );
    expect(active.mock.calls).toEqual([[true]]);
    tracker.onRawMessage(
      update('child', {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'shell',
        state: 'completed',
      })
    );
    expect(active.mock.calls).toEqual([[true], [false]]);
  });

  it('clears failed-load children and activity when a new root replaces the failed provider session', () => {
    // Catches replay from an abandoned load retaining browse access and background activity.
    const active = vi.fn();
    const tracker = new AcpNativeSessionTracker({ onTaskStatusChanged: active });
    tracker.setRootSessionId('root');
    spawn(tracker);
    tracker.setRootSessionId('replacement');
    expect(tracker.ownsSession('child')).toBe(false);
    expect(tracker.list({ limit: 10 }).subagents).toEqual([]);
    expect(active.mock.calls).toEqual([[true], [false]]);
  });

  it('accepts replacement root updates emitted before newSession returns after a failed load', () => {
    // Catches swallowing replacement transcript while the tracker still owns the abandoned root.
    const tracker = new AcpNativeSessionTracker();
    tracker.setCapabilities({ sessionCapabilities: { subagents: {} } });
    tracker.setRootSessionId('root');
    spawn(tracker);
    tracker.resetSession();
    expect(tracker.isAvailable()).toBe(true);
    expect(text(tracker, 'replacement', 'agent', 'Replacement transcript')).toBe(false);
    expect(tracker.ownsSession('child')).toBe(false);
    spawn(tracker, 'replacement', 'new-child');
    expect(tracker.ownsSession('new-child')).toBe(true);
  });

  it('preserves child tool locations repaired at the stdio boundary', () => {
    // Catches dropping a whole child tool update when Claude sends a line range array.
    const tracker = new AcpNativeSessionTracker();
    spawn(tracker);
    tracker.onRawMessage(
      update('child', {
        sessionUpdate: 'tool_call',
        toolCallId: 'read',
        title: 'Read',
        locations: [{ path: '/a', line: [4, 8] }],
      })
    );
    expect(tracker.read({ subagentId: 'child', limit: 10 }).updates).toMatchObject([
      { toolCallId: 'read', locations: [{ path: '/a', line: 4 }] },
    ]);
  });

  it('ignores malformed async completion and forwards child permission requests to the SDK', () => {
    // Catches malformed task updates ending valid work, and consuming a request that needs an answer.
    const active = vi.fn();
    const tracker = new AcpNativeSessionTracker({ onTaskStatusChanged: active });
    tracker.setRootSessionId('root');
    tracker.onRawMessage(
      update('root', { sessionUpdate: 'async_task_spawned', asyncTaskId: 'shell' })
    );
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'shell',
        state: 'invalid',
      })
    );
    expect(active.mock.calls).toEqual([[true]]);
    expect(
      tracker.onRawMessage({
        jsonrpc: '2.0',
        id: 5,
        method: 'session/request_permission',
        params: { sessionId: 'child' },
      })
    ).toBe(false);
    expect(
      tracker.onRawMessage({
        jsonrpc: '2.0',
        id: 6,
        method: 'session/elicitation',
        params: { sessionId: 'child' },
      })
    ).toBe(false);
  });

  it('does not accept an unrelated session into the owned child tree', () => {
    // Catches arbitrary provider session IDs acquiring parent permission routing.
    const tracker = new AcpNativeSessionTracker();
    tracker.setRootSessionId('root');
    expect(spawn(tracker, 'other', 'foreign')).toBe(true);
    expect(tracker.ownsSession('foreign')).toBe(false);
    expect(tracker.list({ limit: 10 }).subagents).toEqual([]);
    spawn(tracker);
    expect(() => tracker.read({ subagentId: 'foreign', limit: 10 })).toThrow();
    expect(() => tracker.list({ cursor: 'garbage', limit: 10 })).toThrow();
  });
});

it('intercepts decoded messages before normalizing and forwarding them to the SDK', async () => {
  // Catches forwarding an invalid draft event to SDK validation or stopping after a swallowed item.
  const child = update('child', { sessionUpdate: 'subagent_spawned' });
  const parent = update('root', {
    sessionUpdate: 'tool_call_update',
    locations: [{ path: '/a', line: [4] }],
  });
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(child);
      controller.enqueue(parent);
      controller.close();
    },
  });
  const reader = createNormalizedAcpReadableStream(
    readable,
    (message) => message === child
  ).getReader();
  expect(await reader.read()).toEqual({
    done: false,
    value: update('root', {
      sessionUpdate: 'tool_call_update',
      locations: [{ path: '/a', line: 4 }],
    }),
  });
  expect(await reader.read()).toEqual({ done: true, value: undefined });
});
