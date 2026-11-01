import { describe, expect, it } from 'vitest';
import { AcpNativeSessionTracker } from './acp-native-session-tracker';

function send(
  tracker: AcpNativeSessionTracker,
  sessionId: string,
  update: Record<string, unknown>
) {
  tracker.onRawMessage({ method: 'session/update', params: { sessionId, update } });
}
function task(tracker: AcpNativeSessionTracker, sessionId = 'root', canStop = true) {
  send(tracker, sessionId, {
    sessionUpdate: 'async_task_spawned',
    asyncTaskId: 'task',
    name: 'Tests',
    canStop,
  });
}
function child(tracker: AcpNativeSessionTracker, id = 'child', cancel?: object) {
  send(tracker, 'root', {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: id,
    name: id,
    capabilities: cancel ? { cancel } : {},
  });
}
function setup() {
  const tracker = new AcpNativeSessionTracker({ groupCodexGenerations: true });
  tracker.setRootSessionId('root');
  return tracker;
}
function taskTarget(tracker: AcpNativeSessionTracker) {
  const item = tracker.getBackgroundWork().backgroundTasks[0]!;
  expect(item.stopControl).toBeDefined();
  return { kind: 'task' as const, id: item.id, controlId: item.stopControl!.controlId };
}
function childTarget(tracker: AcpNativeSessionTracker) {
  const item = tracker.list({ limit: 20 }).subagents[0]!;
  expect(item.stopControl).toBeDefined();
  return { kind: 'subagent' as const, id: item.id, controlId: item.stopControl!.controlId };
}

describe('native targeted stop ownership', () => {
  it('retains provider task identity independently of its display key and isolates siblings', () => {
    const tracker = setup();
    child(tracker);
    task(tracker, 'child');
    task(tracker);
    const target = taskTarget(tracker);
    expect(tracker.resolveStopTarget(target)).toEqual({
      kind: 'task',
      sessionId: 'root',
      asyncTaskId: 'task',
    });
    expect(tracker.getBackgroundWork().backgroundTasks).toHaveLength(2);
    expect(tracker.list({ limit: 20 }).subagents[0]?.status).toBe('running');
  });

  it('does not grant control from active, unsupported, replayed or completed work', () => {
    const tracker = setup();
    task(tracker, 'root', false);
    child(tracker);
    expect(tracker.getBackgroundWork().backgroundTasks[0]?.stopControl).toBeUndefined();
    expect(tracker.list({ limit: 20 }).subagents[0]?.stopControl).toBeUndefined();
    tracker.beginHistoryReplay(true);
    task(tracker);
    child(tracker, 'historical', {});
    tracker.completeHistoryReplay();
    expect(tracker.getBackgroundWork().backgroundTasks[0]?.stopControl).toBeUndefined();
    expect(tracker.list({ limit: 20 }).subagents.every((item) => !item.stopControl)).toBe(true);
    expect(() =>
      tracker.resolveStopTarget({ kind: 'task', id: '["root","task"]', controlId: 'forged' })
    ).toThrow();
  });

  it('fences runtime replacement and reused task IDs even when provider identities match', () => {
    const tracker = setup();
    task(tracker);
    const old = taskTarget(tracker);
    send(tracker, 'root', {
      sessionUpdate: 'async_task_state_update',
      asyncTaskId: 'task',
      state: 'stopped',
    });
    task(tracker);
    expect(() => tracker.resolveStopTarget(old)).toThrow();
    const current = taskTarget(tracker);
    tracker.resetSession();
    tracker.setRootSessionId('root');
    task(tracker);
    expect(() => tracker.resolveStopTarget(current)).toThrow();
    expect(() => setup().resolveStopTarget(taskTarget(tracker))).toThrow();
  });

  it('addresses the current child generation only with an explicit cancel capability', () => {
    const tracker = setup();
    child(tracker, 'child', {});
    child(tracker, 'sibling', {});
    const old = childTarget(tracker);
    expect(tracker.resolveStopTarget(old)).toEqual({ kind: 'subagent', sessionId: 'child' });
    child(tracker, 'child:generation:2', {});
    expect(() => tracker.resolveStopTarget(old)).toThrow();
    const current = childTarget(tracker);
    expect(tracker.resolveStopTarget(current)).toEqual({
      kind: 'subagent',
      sessionId: 'child:generation:2',
    });
    send(tracker, 'root', {
      sessionUpdate: 'subagent_update',
      sessionId: 'child',
      capabilities: { cancel: {} },
    });
    expect(tracker.resolveStopTarget(current).sessionId).toBe('child:generation:2');
    send(tracker, 'root', {
      sessionUpdate: 'subagent_update',
      sessionId: 'child:generation:2',
      capabilities: { cancel: null },
    });
    expect(() => tracker.resolveStopTarget(current)).toThrow();
    expect(tracker.list({ limit: 20 }).subagents[1]?.stopControl).toBeDefined();
  });

  it('withdraws controls during replay and on terminal child state', () => {
    const tracker = setup();
    child(tracker, 'child', {});
    const old = childTarget(tracker);
    tracker.beginHistoryReplay();
    expect(tracker.list({ limit: 20 }).subagents[0]?.stopControl).toBeUndefined();
    expect(() => tracker.resolveStopTarget(old)).toThrow();
    tracker.completeHistoryReplay();
    child(tracker, 'child:generation:2', {});
    const current = childTarget(tracker);
    send(tracker, 'root', {
      sessionUpdate: 'subagent_state_update',
      subagentSessionId: 'child:generation:2',
      state: 'completed',
    });
    expect(() => tracker.resolveStopTarget(current)).toThrow();
  });
});

it('revokes previous task control when a new unsupported task reuses its display identity', () => {
  const tracker = setup();
  task(tracker);
  const previous = taskTarget(tracker);
  send(tracker, 'root', { sessionUpdate: 'async_task_spawned', asyncTaskId: 'task' });
  expect(tracker.getBackgroundWork().backgroundTasks[0]?.stopControl).toBeUndefined();
  expect(() => tracker.resolveStopTarget(previous)).toThrow();
});

it('revokes child-owned task controls when the child generation changes', () => {
  const tracker = setup();
  child(tracker, 'child', {});
  task(tracker, 'child');
  const previous = taskTarget(tracker);
  child(tracker, 'child:generation:2', {});
  expect(() => tracker.resolveStopTarget(previous)).toThrow();
  expect(tracker.getBackgroundWork().backgroundTasks[0]?.stopControl).toBeUndefined();
});

it('cannot regrant task control from a superseded child through a capability-only update', () => {
  const tracker = setup();
  child(tracker, 'child', {});
  task(tracker, 'child');
  child(tracker, 'child:generation:2', {});
  send(tracker, 'child', {
    sessionUpdate: 'async_task_state_update',
    asyncTaskId: 'task',
    canStop: true,
  });
  const row = tracker.getBackgroundWork().backgroundTasks[0]!;
  expect(row.stopControl).toBeUndefined();
  expect(() =>
    tracker.resolveStopTarget({
      kind: 'task',
      id: row.id,
      controlId: row.stopControl?.controlId ?? 'unavailable',
    })
  ).toThrow();
});

it('publishes a matching runtime identity and changes it when the native session resets', () => {
  const tracker = setup();
  task(tracker);
  const old = tracker.getBackgroundWork().backgroundTasks[0]!.stopControl!;
  expect(old.runtimeId).toBe(tracker.getControlRuntimeId());
  tracker.resetSession();
  tracker.setRootSessionId('root');
  task(tracker);
  expect(tracker.getControlRuntimeId()).not.toBe(old.runtimeId);
});
