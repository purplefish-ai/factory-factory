import { describe, expect, it, vi } from 'vitest';
import { AcpNativeSessionTracker } from './acp-native-session-tracker';

function update(tracker: AcpNativeSessionTracker, value: Record<string, unknown>) {
  tracker.onRawMessage({
    method: 'session/update',
    params: { sessionId: 'root', update: value },
  });
}

describe('Background shell activity', () => {
  it.each(['shell', 'local_bash'])(
    'keeps %s processes visible without marking agent work',
    (taskType) => {
      const active = vi.fn();
      const tracker = new AcpNativeSessionTracker({ onTaskStatusChanged: active });
      update(tracker, {
        sessionUpdate: 'async_task_spawned',
        asyncTaskId: 'preview',
        name: 'pnpm storybook',
        taskType,
      });

      expect(active).toHaveBeenLastCalledWith(false);
      expect(tracker.getBackgroundWork().backgroundTasks).toEqual([
        { id: '["root","preview"]', name: 'pnpm storybook', kind: 'shell' },
      ]);

      update(tracker, {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'preview',
        state: 'running',
      });
      expect(active).toHaveBeenLastCalledWith(false);
      update(tracker, {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'preview',
        state: 'completed',
      });
      expect(tracker.getBackgroundWork().backgroundTasks).toEqual([]);
      expect(active).toHaveBeenLastCalledWith(false);
    }
  );

  it.each(['turn', 'task'])(
    'clears work when a %s finishes despite a persistent shell',
    (taskType) => {
      const active = vi.fn();
      const tracker = new AcpNativeSessionTracker({ onTaskStatusChanged: active });
      for (const [asyncTaskId, kind] of [
        ['preview', 'shell'],
        ['agent', taskType],
      ]) {
        update(tracker, { sessionUpdate: 'async_task_spawned', asyncTaskId, taskType: kind });
      }
      expect(active).toHaveBeenLastCalledWith(true);
      update(tracker, {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'agent',
        state: 'completed',
      });
      expect(active).toHaveBeenLastCalledWith(false);
      expect(tracker.getBackgroundWork().backgroundTasks).toMatchObject([{ kind: 'shell' }]);
    }
  );
});
