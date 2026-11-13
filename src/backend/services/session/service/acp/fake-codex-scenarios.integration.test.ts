import { chmod, copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { afterEach, expect, it } from 'vitest';
import { AcpClientFactory, cleanupFailedAcpClientCreation } from './acp-client-factory';
import { AcpPermissionBridge } from './acp-permission-bridge';
import type { AcpProcessHandle } from './acp-process-handle';

// Plays each FF_SANDBOX_SCENARIO of the fake app-server through the released adapter,
// and checks what an ACP client receives for one prompt.

const dirs: string[] = [];
const handles: AcpProcessHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.child.stdin?.end();
    await cleanupFailedAcpClientCreation(handle.child, 'scenario-session');
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

type ClientEvent =
  | { type: 'update'; update: SessionUpdate }
  | { type: 'permission'; params: RequestPermissionRequest };

/**
 * Starts the adapter on the fake and sends `Hello sandbox`. A permission request is answered with
 * `optionId`; `stopAfterFirstChunk` cancels the prompt once the first reply chunk arrives.
 */
async function playScenario(
  scenario: string,
  { optionId = 'allow_once', stopAfterFirstChunk = false } = {}
) {
  // The session working directory arrives resolved; macOS temp dirs live under /private.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ff-scenario-')));
  dirs.push(dir);
  const fake = join(dir, 'codex');
  await copyFile(
    new URL('../../../../testing/fixtures/fake-codex-app-server.mjs', import.meta.url),
    fake
  );
  await chmod(fake, 0o755);
  const factory = new AcpClientFactory();
  factory.configureEnvironment({
    childProcessEnvProvider: () => ({
      PATH: process.env.PATH,
      HOME: dir,
      CODEX_HOME: dir,
      CODEX_PATH: fake,
      FF_SANDBOX_SCENARIO: scenario,
    }),
  });
  const never = {
    promise: new Promise<never>(() => {
      /* No cancellation during the scenario. */
    }),
    dispose() {
      /* Test signal has no listeners. */
    },
  };
  const events: ClientEvent[] = [];
  let prompting = false;
  let stop: (() => void) | undefined;
  const bridge = new AcpPermissionBridge();
  const handle = await factory.createClient({
    sessionId: 'scenario-session',
    options: { provider: 'CODEX', workingDir: dir, sessionId: 'scenario-session' },
    handlers: {
      permissionBridge: bridge,
      onAcpEvent: (_id, event) => {
        if (!prompting) {
          return;
        }
        if (event.type === 'acp_session_update') {
          events.push({ type: 'update', update: event.update });
          if (event.update.sessionUpdate === 'agent_message_chunk') {
            stop?.();
            stop = undefined;
          }
        } else if (event.type === 'acp_permission_request') {
          events.push({ type: 'permission', params: event.params });
          bridge.resolvePermission(event.requestId, optionId);
        }
      },
    },
    metadata: { incarnationId: 'scenario', purpose: 'active', installed: false },
    shutdownSignal: never,
    stopSignal: never,
    shouldDispatchRuntimeError: () => false,
  });
  handles.push(handle);
  prompting = true;
  if (stopAfterFirstChunk) {
    stop = () => void handle.connection.cancel({ sessionId: handle.providerSessionId });
  }
  const response = await handle.connection.prompt({
    sessionId: handle.providerSessionId,
    prompt: [{ type: 'text', text: 'Hello sandbox' }],
  });
  const updates = events.flatMap((event) => (event.type === 'update' ? [event.update] : []));
  const toolUpdates = updates.filter(
    (update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
  );
  return {
    dir,
    response,
    permissions: events.flatMap((event) => (event.type === 'permission' ? [event.params] : [])),
    // The order of what the transcript shows; command and title updates arrive on their own schedule.
    sequence: events.flatMap((event) => {
      if (event.type === 'permission') {
        return ['permission'];
      }
      const kind = event.update.sessionUpdate;
      return kind === 'available_commands_update' || kind === 'session_info_update' ? [] : [kind];
    }),
    toolUpdates,
    chunks: updates.flatMap((update) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
        ? [update.content.text]
        : []
    ),
  };
}

it('echo streams the prompt text back', async () => {
  const played = await playScenario('echo');
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.sequence).toEqual(['agent_message_chunk']);
  expect(played.chunks).toEqual(['Hello sandbox']);
}, 20_000);

it('tool-call shows one command with its output, then the reply', async () => {
  const played = await playScenario('tool-call');
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.sequence).toEqual([
    'tool_call',
    'tool_call_update',
    'tool_call_update',
    'agent_message_chunk',
  ]);
  expect(played.toolUpdates).toMatchObject([
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-call-command',
      title: 'cat README.md',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'cat README.md', cwd: played.dir },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-call-command',
      _meta: {
        terminal_output_delta: { data: 'Scripted README.md contents from the fake provider.\n' },
      },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-call-command',
      status: 'completed',
      _meta: { terminal_exit: { exit_code: 0 } },
    },
  ]);
  expect(played.chunks).toEqual(['I ran cat README.md; it printed one line of scripted text.']);
}, 20_000);

const command = 'echo "Hello from the sandbox"';

it('permission-request asks, then runs the command and replies once approved', async () => {
  const played = await playScenario('permission-request', { optionId: 'allow_once' });
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.sequence).toEqual([
    'permission',
    'tool_call',
    'tool_call_update',
    'tool_call_update',
    'agent_message_chunk',
  ]);
  expect(played.permissions).toMatchObject([
    {
      toolCall: { toolCallId: 'approval-command', rawInput: { command, cwd: played.dir } },
      options: expect.arrayContaining([
        expect.objectContaining({ optionId: 'allow_once', kind: 'allow_once' }),
        expect.objectContaining({ optionId: 'decline', kind: 'reject_once' }),
      ]),
    },
  ]);
  expect(played.toolUpdates).toMatchObject([
    { sessionUpdate: 'tool_call', toolCallId: 'approval-command', title: command, kind: 'execute' },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'approval-command',
      _meta: { terminal_output_delta: { data: 'Hello from the sandbox\n' } },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'approval-command',
      status: 'completed',
      _meta: { terminal_exit: { exit_code: 0 } },
    },
  ]);
  expect(played.chunks).toEqual(['You approved the command, so I ran it.']);
}, 20_000);

it('permission-request replies without running the command once declined', async () => {
  const played = await playScenario('permission-request', { optionId: 'decline' });
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.sequence).toEqual(['permission', 'agent_message_chunk']);
  expect(played.chunks).toEqual(['You declined the command, so I did not run it.']);
}, 20_000);

it('error ends the turn with a session failure the client can show', async () => {
  const played = await playScenario('error');
  expect(played.response).toMatchObject({
    stopReason: 'end_turn',
    _meta: {
      jetbrains: {
        air: {
          sessionFailure: {
            severity: 'error',
            title: 'Sandbox scenario error: the fake provider failed this turn on purpose.',
          },
        },
      },
    },
  });
  expect(played.sequence).toEqual([]);
}, 20_000);

it('slow-stream delivers its reply as several ordered chunks', async () => {
  const played = await playScenario('slow-stream');
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.chunks).toEqual([
    'Streaming ',
    'this ',
    'reply ',
    'one ',
    'chunk ',
    'at ',
    'a ',
    'time.',
  ]);
}, 20_000);

it('slow-stream stops streaming when the client cancels the prompt', async () => {
  const played = await playScenario('slow-stream', { stopAfterFirstChunk: true });
  expect(played.response.stopReason).toBe('cancelled');
  expect(played.chunks).toEqual(['Streaming ']);
}, 20_000);
