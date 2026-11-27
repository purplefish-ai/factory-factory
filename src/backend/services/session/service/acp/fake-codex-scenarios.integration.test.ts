import { mkdirSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { afterEach, expect, it, vi } from 'vitest';
import { codexSessionHistoryLoaderService } from '@/backend/services/session/service/data/codex-session-history-loader.service';
import { AcpEventTranslator } from '@/shared/acp-protocol/session-update-translator';
import { AcpClientFactory, cleanupFailedAcpClientCreation } from './acp-client-factory';
import { AcpPermissionBridge } from './acp-permission-bridge';
import type { AcpProcessHandle } from './acp-process-handle';
import type { AcpRuntimeEvent } from './acp-runtime-events';

// Plays each scenario of the fake app-server through the released adapter, and checks what an
// ACP client receives for one prompt, and what the history loader and a restarted client find.

const dirs: string[] = [];
const handles: AcpProcessHandle[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const handle of handles.splice(0)) {
    await stopClient(handle);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function stopClient(handle: AcpProcessHandle) {
  handle.child.stdin?.end();
  await cleanupFailedAcpClientCreation(handle.child, 'scenario-session');
}

type ClientEvent =
  | { type: 'update'; update: SessionUpdate }
  | { type: 'permission'; params: RequestPermissionRequest };

type FakeHome = { dir: string; fake: string };

/** A new directory holding the fake as `codex`; it is HOME and CODEX_HOME too. */
async function fakeHome(): Promise<FakeHome> {
  // The session working directory arrives resolved; macOS temp dirs live under /private.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ff-scenario-')));
  dirs.push(dir);
  const fake = join(dir, 'codex');
  await copyFile(
    new URL('../../../../testing/fixtures/fake-codex-app-server.mjs', import.meta.url),
    fake
  );
  await chmod(fake, 0o755);
  return { dir, fake };
}

const never = {
  promise: new Promise<never>(() => {
    /* No cancellation during the scenario. */
  }),
  dispose() {
    /* Test signal has no listeners. */
  },
};

/**
 * Starts the adapter on the fake in `home`, resuming `resumeProviderSessionId` when given.
 * `scenario` sets FF_SANDBOX_SCENARIO and `chunkDelayMs` FF_SANDBOX_CHUNK_DELAY_MS; gate files
 * live in `<home>/gates`.
 */
async function startClient(
  home: FakeHome,
  {
    scenario,
    chunkDelayMs,
    resumeProviderSessionId,
    permissionBridge,
    onAcpEvent = () => undefined,
  }: {
    scenario?: string;
    chunkDelayMs?: number;
    resumeProviderSessionId?: string;
    permissionBridge?: AcpPermissionBridge;
    onAcpEvent?: (event: AcpRuntimeEvent) => void;
  } = {}
) {
  const factory = new AcpClientFactory();
  factory.configureEnvironment({
    childProcessEnvProvider: () => ({
      PATH: process.env.PATH,
      HOME: home.dir,
      CODEX_HOME: home.dir,
      CODEX_PATH: home.fake,
      FF_SANDBOX_GATE_DIR: join(home.dir, 'gates'),
      ...(scenario === undefined ? {} : { FF_SANDBOX_SCENARIO: scenario }),
      ...(chunkDelayMs === undefined ? {} : { FF_SANDBOX_CHUNK_DELAY_MS: String(chunkDelayMs) }),
    }),
  });
  const handle = await factory.createClient({
    sessionId: 'scenario-session',
    options: {
      provider: 'CODEX',
      workingDir: home.dir,
      sessionId: 'scenario-session',
      resumeProviderSessionId,
    },
    handlers: { permissionBridge, onAcpEvent: (_id, event) => onAcpEvent(event) },
    metadata: { incarnationId: 'scenario', purpose: 'active', installed: false },
    shutdownSignal: never,
    stopSignal: never,
    shouldDispatchRuntimeError: () => false,
  });
  handles.push(handle);
  return handle;
}

const textOf = (updates: SessionUpdate[], kind: 'agent_message_chunk' | 'user_message_chunk') =>
  updates.flatMap((update) =>
    update.sessionUpdate === kind && update.content.type === 'text' ? [update.content.text] : []
  );

/**
 * Starts the adapter on the fake and sends `prompt`. A permission request is answered with
 * `optionId`; `stopAfterFirstChunk` cancels the prompt once the first reply chunk arrives, and
 * `onFirstChunk` runs then with the fake's home and a count of the reply chunks so far.
 */
async function playScenario(
  scenario: string | undefined,
  {
    optionId = 'allow_once',
    stopAfterFirstChunk = false,
    chunkDelayMs,
    stopAfterRetry = false,
    answers,
    prompt = 'Hello sandbox',
    onFirstChunk,
  }: {
    optionId?: string;
    stopAfterFirstChunk?: boolean;
    chunkDelayMs?: number;
    stopAfterRetry?: boolean;
    answers?: Record<string, string[]>;
    prompt?: string;
    onFirstChunk?: (home: FakeHome, chunkCount: () => number) => void;
  } = {}
) {
  const home = await fakeHome();
  const events: ClientEvent[] = [];
  let prompting = false;
  let stop: (() => void) | undefined;
  let firstChunk = onFirstChunk;
  const bridge = new AcpPermissionBridge();
  const translator = new AcpEventTranslator({ warn: () => undefined });
  const handle = await startClient(home, {
    scenario,
    chunkDelayMs,
    permissionBridge: bridge,
    onAcpEvent: (event) => {
      if (!prompting) {
        return;
      }
      if (event.type === 'acp_session_update') {
        events.push({ type: 'update', update: event.update });
        const update = event.update;
        const isSecondRetry =
          stopAfterRetry &&
          translator
            .translateSessionUpdate(update)
            .some(
              (delta) =>
                delta.type === 'agent_message' &&
                delta.data.type === 'session_notice' &&
                delta.data.notice.title === 'Reconnecting... 2/5'
            );
        if (update.sessionUpdate === 'agent_message_chunk' || isSecondRetry) {
          stop?.();
          stop = undefined;
        }
        if (update.sessionUpdate === 'agent_message_chunk') {
          firstChunk?.(
            home,
            () =>
              events.filter(
                (sent) =>
                  sent.type === 'update' && sent.update.sessionUpdate === 'agent_message_chunk'
              ).length
          );
          firstChunk = undefined;
        }
      } else if (event.type === 'acp_permission_request') {
        events.push({ type: 'permission', params: event.params });
        bridge.resolvePermission(event.requestId, optionId, answers);
      }
    },
  });
  prompting = true;
  if (stopAfterFirstChunk || stopAfterRetry) {
    stop = () => void handle.connection.cancel({ sessionId: handle.providerSessionId });
  }
  const response = await handle.connection.prompt({
    sessionId: handle.providerSessionId,
    prompt: [{ type: 'text', text: prompt }],
  });
  const updates = events.flatMap((event) => (event.type === 'update' ? [event.update] : []));
  const toolUpdates = updates.filter(
    (update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
  );
  return {
    dir: home.dir,
    home,
    handle,
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
    updates,
    chunks: textOf(updates, 'agent_message_chunk'),
  };
}

/** What the application's history loader reads for the session, from the fake's CODEX_HOME. */
async function loadHistory(home: FakeHome, providerSessionId: string) {
  vi.stubEnv('CODEX_HOME', home.dir);
  // As in the sandbox, the sessions directory follows CODEX_HOME.
  vi.stubEnv('CODEX_SESSIONS_DIR', undefined);
  return await codexSessionHistoryLoaderService.loadSessionHistory({
    providerSessionId,
    workingDir: home.dir,
  });
}

it('a prompt chooses its scenario with no FF_SANDBOX_SCENARIO', async () => {
  const played = await playScenario(undefined, { prompt: 'Please ff-scenario:tool-call' });
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.sequence).toEqual([
    'tool_call',
    'tool_call_update',
    'tool_call_update',
    'agent_message_chunk',
  ]);
  expect(played.chunks).toEqual(['I ran cat README.md; it printed one line of scripted text.']);
}, 20_000);

it('gated-stream holds its reply until the client creates the gate file', async () => {
  let chunksBeforeRelease = 0;
  const played = await playScenario(undefined, {
    prompt: 'ff-scenario:gated-stream:client-gate',
    onFirstChunk: ({ dir }, chunkCount) => {
      // Several polls of the gate pass with no file: the reply must still be held.
      setTimeout(() => {
        chunksBeforeRelease = chunkCount();
        mkdirSync(join(dir, 'gates'), { recursive: true });
        writeFileSync(join(dir, 'gates', 'client-gate'), '');
      }, 400);
    },
  });
  expect(chunksBeforeRelease).toBe(1);
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.chunks).toEqual(['Waiting at gate client-gate. ', 'Gate client-gate released.']);
}, 20_000);

it.each([
  [
    'echo',
    [
      { type: 'user', content: 'Hello sandbox' },
      { type: 'assistant', content: 'Hello sandbox' },
    ],
  ],
  [
    'tool-call',
    [
      { type: 'user', content: 'Hello sandbox' },
      {
        type: 'tool_use',
        toolName: 'exec_command',
        toolId: 'tool-call-command',
        toolInput: { cmd: 'cat README.md' },
      },
      {
        type: 'tool_result',
        toolId: 'tool-call-command',
        content: 'Scripted README.md contents from the fake provider.\n',
      },
      {
        type: 'assistant',
        content: 'I ran cat README.md; it printed one line of scripted text.',
      },
    ],
  ],
])(
  'the history loader reads the %s turn from the rollout file the fake wrote',
  async (scenario, history) => {
    const played = await playScenario(scenario);
    expect(played.response.stopReason).toBe('end_turn');
    expect(await loadHistory(played.home, played.handle.providerSessionId)).toMatchObject({
      status: 'loaded',
      history,
    });
  },
  20_000
);

it('a restarted client replays a recorded command with its output', async () => {
  const played = await playScenario('tool-call');
  handles.splice(handles.indexOf(played.handle), 1);
  await stopClient(played.handle);
  const replayed: SessionUpdate[] = [];
  await startClient(played.home, {
    resumeProviderSessionId: played.handle.providerSessionId,
    onAcpEvent: (event) => {
      if (event.type === 'acp_session_update') {
        replayed.push(event.update);
      }
    },
  });
  expect(replayed).toContainEqual(
    expect.objectContaining({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-call-command',
      title: 'cat README.md',
    })
  );
  expect(textOf(replayed, 'agent_message_chunk')).toEqual([
    'I ran cat README.md; it printed one line of scripted text.',
  ]);
}, 30_000);

it('a restarted client resumes the conversation from its rollout file and continues it', async () => {
  const played = await playScenario('echo', { prompt: 'Before the restart' });
  const providerSessionId = played.handle.providerSessionId;
  /** Stops `handle`, as a restart does, and resumes the conversation in a new process. */
  const restart = async (handle: AcpProcessHandle) => {
    handles.splice(handles.indexOf(handle), 1);
    await stopClient(handle);
    const replayed: SessionUpdate[] = [];
    const resumed = await startClient(played.home, {
      scenario: 'echo',
      resumeProviderSessionId: providerSessionId,
      onAcpEvent: (event) => {
        if (event.type === 'acp_session_update') {
          replayed.push(event.update);
        }
      },
    });
    expect(resumed.sessionCreationOutcome.kind).toBe('resumed');
    expect(resumed.providerSessionId).toBe(providerSessionId);
    return { resumed, replayed };
  };

  const first = await restart(played.handle);
  expect(textOf(first.replayed, 'user_message_chunk')).toEqual(['Before the restart']);
  expect(textOf(first.replayed, 'agent_message_chunk')).toEqual(['Before the restart']);
  await expect(
    first.resumed.connection.prompt({
      sessionId: providerSessionId,
      prompt: [{ type: 'text', text: 'After the restart' }],
    })
  ).resolves.toMatchObject({ stopReason: 'end_turn' });
  expect(await loadHistory(played.home, providerSessionId)).toMatchObject({
    status: 'loaded',
    history: [
      { type: 'user', content: 'Before the restart' },
      { type: 'assistant', content: 'Before the restart' },
      { type: 'user', content: 'After the restart' },
      { type: 'assistant', content: 'After the restart' },
    ],
  });

  // Both processes numbered their turns alike; a second restart still replays two turns.
  const second = await restart(first.resumed);
  const prompts = ['Before the restart', 'After the restart'];
  expect(textOf(second.replayed, 'user_message_chunk')).toEqual(prompts);
  expect(textOf(second.replayed, 'agent_message_chunk')).toEqual(prompts);
}, 30_000);

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

it('steers an async question response while the Codex turn is still running', async () => {
  const played = await playScenario('async-question', {
    optionId: 'accept',
    answers: { question_0: ['Approve wording'] },
  });
  expect(played.response.stopReason).toBe('end_turn');
  expect(played.permissions).toMatchObject([{ toolCall: { rawInput: { delivery: 'async' } } }]);
  expect(played.chunks).toContain('The async answer reached Codex.');
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
  const played = await playScenario('slow-stream', { chunkDelayMs: 5 });
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
  // Longer than the test's timeout: only the cancel can end the stream before it times out.
  const played = await playScenario('slow-stream', {
    stopAfterFirstChunk: true,
    chunkDelayMs: 60_000,
  });
  expect(played.response.stopReason).toBe('cancelled');
  expect(played.chunks).toEqual(['Streaming ']);
}, 20_000);

it.each(['retry-recover', 'retry-fail'])(
  '%s carries one structured retry identity through the pinned adapter',
  async (scenario) => {
    const played = await playScenario(scenario, { chunkDelayMs: 5 });
    const translator = new AcpEventTranslator({ warn: () => undefined });
    const retries = played.updates.flatMap((update) =>
      translator
        .translateSessionUpdate(update, 'scenario-session')
        .flatMap((event) =>
          event.type === 'agent_message' && event.data.type === 'session_notice'
            ? [event.data.notice]
            : []
        )
    );
    expect(retries).toMatchObject([
      {
        id: expect.any(String),
        severity: 'warning',
        category: 'connection',
        title: 'Reconnecting... 1/5',
      },
      {
        id: retries[0]?.id,
        severity: 'warning',
        category: 'connection',
        title: 'Reconnecting... 2/5',
      },
    ]);
    expect(retries[1]!.revision).toBeGreaterThan(retries[0]!.revision);
    if (scenario === 'retry-recover') {
      expect(played.chunks).toEqual(['The scripted response resumed.']);
      expect(played.response).toMatchObject({ stopReason: 'end_turn' });
    } else {
      expect(played.chunks).toEqual([]);
      expect(played.response).toMatchObject({
        _meta: {
          jetbrains: {
            air: {
              sessionFailure: {
                id: retries[0]?.id,
                severity: 'error',
                title: 'The scripted response stream disconnected.',
              },
            },
          },
        },
      });
    }
  },
  20_000
);

it('cancels a retry wait promptly without emitting a terminal connection error', async () => {
  const played = await playScenario('retry-fail', { stopAfterRetry: true, chunkDelayMs: 60_000 });
  expect(played.response.stopReason).toBe('cancelled');
  expect(played.response._meta?.jetbrains).toBeUndefined();
  expect(played.chunks).toEqual([]);
}, 20_000);
