import { subagentForm } from '@agentclientprotocol/claude-agent-acp/dist/acp-subagents.js';
import { NativeSubagentRuntime } from '@agentclientprotocol/claude-agent-acp/dist/native-subagents.js';
import { expect, it } from 'vitest';
import { AcpNativeSessionTracker } from './acp-native-session-tracker';

it('keeps the released Claude AIR children browseable without cancellation capability', async () => {
  const form = subagentForm({
    subagents: {},
    _meta: {
      jetbrains: {
        air: { version: 1, capabilities: ['asyncTasks', 'sessionFailure', 'loadReplayEnd'] },
      },
    },
  });
  expect(form).toBe('air');
  const tracker = new AcpNativeSessionTracker();
  tracker.setRootSessionId('root');
  const publish = (params: unknown) => {
    tracker.onRawMessage({ method: 'session/update', params });
    return Promise.resolve();
  };
  const runtime = new NativeSubagentRuntime(form, 'root', {}, publish, {
    log() {
      /* No adapter logging needed for this contract. */
    },
  });
  await runtime.taskStarted(
    { taskId: 'native-child', subagentType: 'general-purpose', description: 'Contract child' },
    publish
  );
  const child = tracker.list({ limit: 10 }).subagents[0];
  expect(child).toMatchObject({ status: 'running' });
  expect(child?.stopControl).toBeUndefined();
});
