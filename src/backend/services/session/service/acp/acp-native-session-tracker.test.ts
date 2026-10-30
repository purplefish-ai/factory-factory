import type {
  CreateElicitationRequest,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk/unstable';
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
  it('forwards child tool updates, but not root or text updates, to tool observers', () => {
    const onSubagentToolUpdate = vi.fn();
    const tracker = new AcpNativeSessionTracker({ onSubagentToolUpdate });
    tracker.setRootSessionId('root');
    spawn(tracker);
    const toolCall = {
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_1',
      title: 'Terminal',
      kind: 'execute',
      status: 'pending',
    };
    const toolUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_1',
      rawInput: { command: 'gh pr create --fill' },
    };

    expect(tracker.onRawMessage(update('child', toolCall))).toBe(true);
    expect(tracker.onRawMessage(update('child', toolUpdate))).toBe(true);
    text(tracker, 'child', 'agent', 'Opened the PR.');
    expect(tracker.onRawMessage(update('root', { ...toolCall, toolCallId: 'toolu_root' }))).toBe(
      false
    );

    expect(onSubagentToolUpdate.mock.calls).toEqual([
      ['child', expect.objectContaining(toolCall)],
      ['child', expect.objectContaining(toolUpdate)],
    ]);
  });

  it('retains replayed child tools for browsing without forwarding their side effects', () => {
    const onSubagentToolUpdate = vi.fn();
    const onTaskStatusChanged = vi.fn();
    const tracker = new AcpNativeSessionTracker({ onSubagentToolUpdate, onTaskStatusChanged });
    tracker.setRootSessionId('root');
    tracker.beginHistoryReplay();
    spawn(tracker);
    const tool = {
      sessionUpdate: 'tool_call',
      toolCallId: 'historical-pr',
      title: 'gh pr create',
      kind: 'execute',
      status: 'completed',
    };
    tracker.onRawMessage(update('child', tool));
    expect(onSubagentToolUpdate).not.toHaveBeenCalled();
    expect(onTaskStatusChanged).not.toHaveBeenCalled();
    expect(tracker.getBackgroundWork()).toEqual({
      backgroundTasks: [],
      runningSubagents: 0,
      activeGoals: 0,
    });
    tracker.completeHistoryReplay();
    expect(tracker.read({ subagentId: 'child', limit: 10 }).updates).toMatchObject([tool]);

    spawn(tracker, 'root', 'live-child');
    tracker.onRawMessage(update('live-child', { ...tool, toolCallId: 'new-pr' }));
    expect(onSubagentToolUpdate).toHaveBeenCalledOnce();
    expect(onSubagentToolUpdate).toHaveBeenCalledWith(
      'live-child',
      expect.objectContaining({ toolCallId: 'new-pr' })
    );
    expect(onTaskStatusChanged).toHaveBeenLastCalledWith(true);
  });

  it('uses a task type learned after the first update and preserves it on nameless updates', () => {
    const tracker = new AcpNativeSessionTracker();
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'turn',
        state: 'running',
      })
    );
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'async_task_spawned',
        asyncTaskId: 'turn',
        name: 'Claude is working',
        taskType: 'turn',
      })
    );
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'turn',
        state: 'running',
      })
    );
    expect(tracker.getBackgroundWork().backgroundTasks).toEqual([
      { id: '["root","turn"]', name: 'Claude is working', kind: 'turn' },
    ]);
  });

  it('retains command identity across a pause and a nameless running update', () => {
    const tracker = new AcpNativeSessionTracker();
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'async_task_spawned',
        asyncTaskId: 'preview',
        name: 'pnpm storybook',
        taskType: 'shell',
      })
    );
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'preview',
        state: 'paused',
      })
    );
    expect(tracker.getBackgroundWork().backgroundTasks).toEqual([]);
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'preview',
        state: 'running',
      })
    );
    expect(tracker.getBackgroundWork().backgroundTasks).toEqual([
      { id: '["root","preview"]', name: 'pnpm storybook', kind: 'shell' },
    ]);
  });

  it('publishes named work changes even while another background task remains active', () => {
    const tracker = new AcpNativeSessionTracker();
    const snapshots: unknown[] = [];
    const observed = new AcpNativeSessionTracker({
      onTaskStatusChanged: () => snapshots.push(observed.getBackgroundWork()),
    });
    for (const [id, name] of [
      ['preview', 'pnpm storybook'],
      ['tests', 'pnpm test'],
    ]) {
      observed.onRawMessage(
        update('root', {
          sessionUpdate: 'async_task_spawned',
          asyncTaskId: id,
          name,
        })
      );
    }
    observed.onRawMessage(
      update('root', {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'tests',
        state: 'completed',
      })
    );
    expect(snapshots).toMatchObject([
      { backgroundTasks: [{ name: 'pnpm storybook' }] },
      { backgroundTasks: [{ name: 'pnpm storybook' }, { name: 'pnpm test' }] },
      { backgroundTasks: [{ name: 'pnpm storybook' }] },
    ]);
    observed.resetSession();
    expect(snapshots.at(-1)).toEqual({ backgroundTasks: [], runningSubagents: 0, activeGoals: 0 });
    expect(tracker.getBackgroundWork()).toEqual({
      backgroundTasks: [],
      runningSubagents: 0,
      activeGoals: 0,
    });
  });

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

  it('retains the last 500 characters of streamed child output including whitespace chunks', () => {
    const tracker = new AcpNativeSessionTracker();
    spawn(tracker);
    text(tracker, 'child', 'agent', 'x'.repeat(600));
    text(tracker, 'child', 'agent', 'x'.repeat(490));
    text(tracker, 'child', 'agent', ' ');
    text(tracker, 'child', 'agent', 'finished');
    expect(tracker.list({ limit: 10 }).subagents[0]?.resultPreview).toBe(
      `${'x'.repeat(491)} finished`
    );
  });

  it.each(['completed', 'failed', 'cancelled', 'disconnected'])(
    'clears an active child goal when the child becomes %s',
    (state) => {
      const active = vi.fn();
      const tracker = new AcpNativeSessionTracker({ onTaskStatusChanged: active });
      spawn(tracker);
      tracker.onRawMessage(
        update('child', {
          sessionUpdate: 'session_info_update',
          _meta: { jetbrains: { air: { goal: { status: 'active' } } } },
        })
      );
      tracker.onRawMessage(
        update('root', {
          sessionUpdate: 'subagent_state_update',
          subagentSessionId: 'child',
          state,
        })
      );
      // Adding the goal also publishes updated details while the child remains active.
      expect(active.mock.calls).toEqual([[true], [true], [false]]);
    }
  );

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

  it('keeps agent activity until every child and goal ends despite a remaining shell', () => {
    // Catches a shell retaining work after children and goals have finished.
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
    expect(active.mock.calls).toEqual([[true], [true], [true], [true], [false]]);
    tracker.onRawMessage(
      update('child', {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'shell',
        state: 'completed',
      })
    );
    expect(active.mock.calls).toEqual([[true], [true], [true], [true], [false], [false]]);
  });

  it('evicts oldest whole turns while keeping retained cursors stable and rejecting expired cursors', () => {
    const tracker = new AcpNativeSessionTracker();
    spawn(tracker);
    function turn(index: number) {
      text(tracker, 'child', 'user', `Question ${index}`, `u${index}`);
      text(tracker, 'child', 'agent', `Answer ${index}`);
    }
    turn(0);
    turn(1);
    const expired = tracker.read({ subagentId: 'child', limit: 1 }).nextCursor;
    for (let index = 2; index < 100; index += 1) {
      turn(index);
    }
    const retained = tracker.read({ subagentId: 'child', limit: 1 }).nextCursor;
    turn(100);
    turn(101);
    const latest = tracker.read({ subagentId: 'child', limit: 100 });
    expect(latest.updates).toHaveLength(200);
    expect(latest.updates[0]).toMatchObject({ content: { text: 'Question 2' } });
    expect(latest.nextCursor).toBeNull();
    expect(tracker.read({ subagentId: 'child', cursor: retained, limit: 1 }).updates).toMatchObject(
      [{ content: { text: 'Question 98' } }, { content: { text: 'Answer 98' } }]
    );
    expect(() => tracker.read({ subagentId: 'child', cursor: expired, limit: 1 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });

  it('bounds retained tool payload bytes by evicting whole turns including their tool results', () => {
    const tracker = new AcpNativeSessionTracker();
    spawn(tracker);
    for (const id of ['first', 'second', 'third']) {
      text(tracker, 'child', 'user', id, id);
      tracker.onRawMessage(
        update('child', {
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title: 'Inspect output',
          rawInput: { payload: '🐈'.repeat(200_000) },
        })
      );
      tracker.onRawMessage(
        update('child', {
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: 'completed',
        })
      );
      text(tracker, 'child', 'agent', 'Done');
    }
    const latest = tracker.read({ subagentId: 'child', limit: 100 });
    expect(latest.updates).toHaveLength(8);
    expect(latest.updates[0]).toMatchObject({ content: { text: 'second' } });
    expect(latest.updates[1]).toMatchObject({ toolCallId: 'second' });
    expect(latest.updates[2]).toMatchObject({ toolCallId: 'second', status: 'completed' });
    expect(latest.nextCursor).toBeNull();
  });

  it('discards an oversized streamed turn through its final chunk and resumes at the next user turn', () => {
    const tracker = new AcpNativeSessionTracker();
    spawn(tracker);
    spawn(tracker, 'root', 'sibling');
    text(tracker, 'sibling', 'agent', 'Sibling output');
    text(tracker, 'child', 'user', 'Verbose turn', 'verbose');
    for (let chunk = 0; chunk < 3; chunk += 1) {
      text(tracker, 'child', 'agent', 'x'.repeat(800_000));
    }
    text(tracker, 'child', 'agent', 'finished');
    expect(tracker.read({ subagentId: 'child', limit: 100 }).updates).toHaveLength(0);
    expect(tracker.list({ limit: 10 }).subagents[0]?.resultPreview).toBe(
      `${'x'.repeat(492)}finished`
    );
    text(tracker, 'child', 'user', 'Recovered', 'next');
    text(tracker, 'child', 'agent', 'Done');
    expect(tracker.read({ subagentId: 'child', limit: 100 }).updates).toMatchObject([
      { content: { text: 'Recovered' } },
      { content: { text: 'Done' } },
    ]);
    expect(tracker.read({ subagentId: 'sibling', limit: 100 }).updates).toMatchObject([
      { content: { text: 'Sibling output' } },
    ]);
    expect(text(tracker, 'root', 'agent', 'Parent output')).toBe(false);
  });

  it('bounds synthetic delegated prompts and keeps their replay in the same user turn', () => {
    const tracker = new AcpNativeSessionTracker();
    tracker.onRawMessage(
      update('root', {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: 'child',
        name: 'Worker',
        prompt: 'x'.repeat(3_000_000),
      })
    );
    expect(tracker.read({ subagentId: 'child', limit: 100 }).updates).toHaveLength(0);
    text(tracker, 'child', 'user', 'Replayed prompt', 'actual');
    text(tracker, 'child', 'user', ' continued', 'actual');
    text(tracker, 'child', 'agent', 'Answer');
    expect(tracker.read({ subagentId: 'child', limit: 1 }).updates).toMatchObject([
      { content: { text: 'Replayed prompt' } },
      { content: { text: ' continued' } },
      { content: { text: 'Answer' } },
    ]);
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

  it.each(['root', 'child'])(
    'quarantines delayed abandoned %s updates before adopting the replacement root',
    (abandonedId) => {
      const tracker = new AcpNativeSessionTracker();
      tracker.setRootSessionId('root');
      spawn(tracker);
      tracker.resetSession();
      expect(text(tracker, abandonedId, 'agent', 'Delayed abandoned output')).toBe(true);
      expect(spawn(tracker, abandonedId, 'delayed-child')).toBe(true);
      expect(text(tracker, 'replacement', 'agent', 'Replacement output')).toBe(false);
      spawn(tracker, 'replacement', 'new-child');
      tracker.setRootSessionId('replacement');
      expect(tracker.list({ limit: 10 }).subagents).toMatchObject([{ id: 'new-child' }]);
    }
  );

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

  it('ignores malformed async completion', () => {
    // Catches malformed task updates ending valid work.
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
  });

  it('forwards child permission and elicitation requests unchanged through the SDK stream', async () => {
    const tracker = new AcpNativeSessionTracker();
    spawn(tracker);
    const requests = [
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'session/request_permission',
        params: {
          sessionId: 'child',
          toolCall: { toolCallId: 'edit', title: 'Edit', status: 'pending' },
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }],
        } satisfies RequestPermissionRequest,
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'elicitation/create',
        params: {
          sessionId: 'child',
          mode: 'form',
          message: 'Choose settings',
          requestedSchema: { properties: { note: { type: 'string' } } },
        } satisfies CreateElicitationRequest,
      },
    ];
    const readable = new ReadableStream({
      start(controller) {
        for (const request of requests) {
          controller.enqueue(request);
        }
        controller.close();
      },
    });
    const reader = createNormalizedAcpReadableStream(readable, (message) =>
      tracker.onRawMessage(message)
    ).getReader();
    for (const request of requests) {
      const result = await reader.read();
      expect(result.done).toBe(false);
      expect(result.value).toBe(request);
    }
    expect(await reader.read()).toEqual({ done: true, value: undefined });
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
