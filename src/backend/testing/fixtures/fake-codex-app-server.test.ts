import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getBundledCodexCommand } from '@/backend/lib/codex-cli-command';

const fakePath = fileURLToPath(new URL('./fake-codex-app-server.mjs', import.meta.url));
const threadId = '11111111-1111-4111-8111-111111111111';
const cwd = '/sandbox/project';
const messageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
});
type Message = z.infer<typeof messageSchema>;

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
});

// Longer than any test here: a stop test can only time out, never see the next chunk.
const neverMs = '60000';

function startFake(scenario?: string, extraEnv: Record<string, string> = {}, args: string[] = []) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ...extraEnv };
  if (scenario !== undefined) {
    env.FF_SANDBOX_SCENARIO = scenario;
  }
  const child = spawn(process.execPath, [fakePath, ...args], { env });
  children.push(child);
  return child;
}

/**
 * Sends one prompt and returns every message the fake writes until the turn completes.
 * Server requests are answered with `decision`, and stay in the returned list. The first
 * message with the method `interruptOn` is followed by `turn/interrupt` instead of an answer.
 */
async function playPrompt(
  child: ChildProcessWithoutNullStreams,
  { decision = 'accept', interruptOn }: { decision?: string; interruptOn?: string } = {}
) {
  let interrupted = false;
  const messages: Message[] = [];
  const lines = createInterface({ input: child.stdout });
  const done = new Promise<void>((resolve) => {
    lines.on('line', (line) => {
      const message = messageSchema.parse(JSON.parse(line));
      messages.push(message);
      if (!interrupted && message.method !== undefined && message.method === interruptOn) {
        interrupted = true;
        const interrupt = { id: 8, method: 'turn/interrupt', params: { threadId, turnId } };
        child.stdin.write(`${JSON.stringify(interrupt)}\n`);
      } else if (message.method !== undefined && message.id !== undefined) {
        child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision } })}\n`);
      }
      if (message.method === 'turn/completed') {
        resolve();
      }
    });
  });
  child.stdin.write(
    `${JSON.stringify({
      id: 7,
      method: 'turn/start',
      params: {
        threadId,
        cwd,
        input: [{ type: 'text', text: 'Hello sandbox', text_elements: [] }],
      },
    })}\n`
  );
  await done;
  lines.close();
  return messages;
}

const turnId = 'turn-7';
const turnStartResponse = { id: 7, result: { turn: { id: turnId, status: 'inProgress' } } };
const turnStarted = { method: 'turn/started', params: { threadId, turn: { id: turnId } } };
const turnCompleted = (status: string) => ({
  method: 'turn/completed',
  params: { threadId, turn: { id: turnId, status } },
});
const message = (id: string, text: string, deltas: string[]) => [
  {
    method: 'item/started',
    params: { threadId, turnId, item: { type: 'agentMessage', id, text: '' } },
  },
  ...deltas.map((delta) => ({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, itemId: id, delta },
  })),
  {
    method: 'item/completed',
    params: { threadId, turnId, item: { type: 'agentMessage', id, text } },
  },
];

describe('fake Codex app-server scenarios', () => {
  it('keeps the contract reply when FF_SANDBOX_SCENARIO is unset', async () => {
    expect(await playPrompt(startFake())).toMatchObject([
      turnStartResponse,
      ...message('message', 'Synthetic response', ['Synthetic response']),
      turnCompleted('completed'),
    ]);
  });

  it('echo replies with the prompt text', async () => {
    expect(await playPrompt(startFake('echo'))).toMatchObject([
      turnStartResponse,
      turnStarted,
      ...message('message-1', 'Hello sandbox', ['Hello sandbox']),
      turnCompleted('completed'),
    ]);
  });

  it('tool-call runs one command with fixed output, then replies', async () => {
    const readme = 'Scripted README.md contents from the fake provider.\n';
    const commandItem = {
      type: 'commandExecution',
      id: 'tool-call-command',
      command: 'cat README.md',
      cwd,
      commandActions: [{ type: 'unknown', command: 'cat README.md' }],
    };
    expect(await playPrompt(startFake('tool-call'))).toMatchObject([
      turnStartResponse,
      turnStarted,
      {
        method: 'item/started',
        params: { threadId, turnId, item: { ...commandItem, status: 'inProgress' } },
      },
      {
        method: 'item/commandExecution/outputDelta',
        params: { threadId, turnId, itemId: 'tool-call-command', delta: readme },
      },
      {
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: { ...commandItem, status: 'completed', aggregatedOutput: readme, exitCode: 0 },
        },
      },
      ...message('message-1', 'I ran cat README.md; it printed one line of scripted text.', [
        'I ran cat README.md; it printed one line of scripted text.',
      ]),
      turnCompleted('completed'),
    ]);
  });

  const command = 'echo "Hello from the sandbox"';
  const approvalRequest = {
    id: 'fake-server-request-1',
    method: 'item/commandExecution/requestApproval',
    params: {
      kind: 'command',
      threadId,
      turnId,
      itemId: 'approval-command',
      command,
      cwd,
      commandActions: [{ type: 'unknown', command }],
    },
  };

  it('permission-request runs the command once it is approved', async () => {
    const commandItem = { type: 'commandExecution', id: 'approval-command', command, cwd };
    expect(await playPrompt(startFake('permission-request'), { decision: 'accept' })).toMatchObject(
      [
        turnStartResponse,
        turnStarted,
        approvalRequest,
        {
          method: 'item/started',
          params: { threadId, turnId, item: { ...commandItem, status: 'inProgress' } },
        },
        {
          method: 'item/commandExecution/outputDelta',
          params: {
            threadId,
            turnId,
            itemId: 'approval-command',
            delta: 'Hello from the sandbox\n',
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: { ...commandItem, status: 'completed', exitCode: 0 },
          },
        },
        ...message('message-1', 'You approved the command, so I ran it.', [
          'You approved the command, so I ran it.',
        ]),
        turnCompleted('completed'),
      ]
    );
  });

  it('permission-request skips the command once it is declined', async () => {
    expect(
      await playPrompt(startFake('permission-request'), { decision: 'decline' })
    ).toMatchObject([
      turnStartResponse,
      turnStarted,
      approvalRequest,
      ...message('message-1', 'You declined the command, so I did not run it.', [
        'You declined the command, so I did not run it.',
      ]),
      turnCompleted('completed'),
    ]);
  });

  it('error fails the turn with a visible error', async () => {
    const error = {
      message: 'Sandbox scenario error: the fake provider failed this turn on purpose.',
      codexErrorInfo: null,
    };
    expect(await playPrompt(startFake('error'))).toMatchObject([
      turnStartResponse,
      turnStarted,
      { method: 'error', params: { threadId, turnId, willRetry: false, error } },
      {
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'failed', error } },
      },
    ]);
  });

  const chunks = ['Streaming ', 'this ', 'reply ', 'one ', 'chunk ', 'at ', 'a ', 'time.'];
  const slowStream = [
    turnStartResponse,
    turnStarted,
    ...message('message-1', chunks.join(''), chunks),
    turnCompleted('completed'),
  ];

  it('slow-stream sends one reply in several deltas with the default delay', async () => {
    expect(await playPrompt(startFake('slow-stream'))).toMatchObject(slowStream);
  }, 10_000);

  // At the 400 ms default the 8 chunks take 2.8 s, longer than this test may run.
  it('slow-stream uses FF_SANDBOX_CHUNK_DELAY_MS between deltas', async () => {
    const child = startFake('slow-stream', { FF_SANDBOX_CHUNK_DELAY_MS: '5' });
    expect(await playPrompt(child)).toMatchObject(slowStream);
  }, 2000);

  it.each(['0', '-1', 'abc', ''])('rejects FF_SANDBOX_CHUNK_DELAY_MS %j', async (value) => {
    const child = startFake('slow-stream', { FF_SANDBOX_CHUNK_DELAY_MS: value });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = await once(child, 'close');
    expect(code).toBe(2);
    expect(stderr).toBe(
      `Invalid FF_SANDBOX_CHUNK_DELAY_MS "${value}": expected a positive whole number of milliseconds.\n`
    );
  });

  it('exits once stdin closes while a long chunk delay is pending', async () => {
    const child = startFake('slow-stream', { FF_SANDBOX_CHUNK_DELAY_MS: neverMs });
    const lines = createInterface({ input: child.stdout });
    const firstDelta = new Promise<void>((resolve) => {
      lines.on('line', (line) => {
        if (messageSchema.parse(JSON.parse(line)).method === 'item/agentMessage/delta') {
          resolve();
        }
      });
    });
    child.stdin.write(`${JSON.stringify({ id: 7, method: 'turn/start', params: { threadId } })}\n`);
    await firstDelta;
    const closed = once(child, 'close');
    child.stdin.end();
    expect(await closed).toEqual([0, null]);
  });

  it('slow-stream stops streaming on turn/interrupt, then exits once stdin closes', async () => {
    const [started, delta, completed] = message('message-1', 'Streaming ', ['Streaming ']);
    const child = startFake('slow-stream', { FF_SANDBOX_CHUNK_DELAY_MS: neverMs });
    expect(await playPrompt(child, { interruptOn: 'item/agentMessage/delta' })).toMatchObject([
      turnStartResponse,
      turnStarted,
      started,
      delta,
      { id: 8, result: {} },
      completed,
      turnCompleted('interrupted'),
    ]);
    const closed = once(child, 'close');
    child.stdin.end();
    expect(await closed).toEqual([0, null]);
  });

  it('permission-request cancels its approval and ends on turn/interrupt', async () => {
    expect(
      await playPrompt(startFake('permission-request'), {
        interruptOn: 'item/commandExecution/requestApproval',
      })
    ).toMatchObject([
      turnStartResponse,
      turnStarted,
      approvalRequest,
      { id: 8, result: {} },
      turnCompleted('interrupted'),
    ]);
  });

  it.each(['nope', ''])('exits with the valid scenario names for %j', async (name) => {
    const child = startFake(name);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = await once(child, 'close');
    expect(code).toBe(2);
    expect(stderr).toBe(
      `Unknown FF_SANDBOX_SCENARIO "${name}". Valid scenarios: echo, tool-call, permission-request, error, slow-stream\n`
    );
  });
});

/** Runs the fake to exit with stdin left open, as `execFile` leaves it. */
async function runToExit(child: ChildProcessWithoutNullStreams) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

const fakeVersion = 'codex-cli 0.0.0-fake\n';

describe('fake Codex command line', () => {
  it.each([['-V'], ['--version']])('%s prints a version line and exits', async (flag) => {
    expect(await runToExit(startFake('echo', {}, [flag]))).toEqual({
      code: 0,
      stdout: fakeVersion,
      stderr: '',
    });
  });

  it('login status reports a logged-in state and exits', async () => {
    expect(await runToExit(startFake('echo', {}, ['login', 'status']))).toEqual({
      code: 0,
      stdout: '',
      stderr: 'Logged in using ChatGPT\n',
    });
  });

  it.each([
    [['login']],
    [['exec', '--ephemeral', '-']],
    [['--bogus']],
    [['login', 'status', '--json']],
    [['app-server', '--listen', 'stdio://']],
    [['app-server', '-c']],
  ])('refuses %j with one line on stderr instead of waiting on stdin', async (args) => {
    expect(await runToExit(startFake('echo', {}, args))).toEqual({
      code: 2,
      stdout: '',
      stderr: `fake Codex: unsupported arguments: ${args.join(' ')}\n`,
    });
  });

  // The adapter starts sessions with `app-server`, adding `-c hooks=…` when hooks are configured.
  it.each([[['app-server']], [['app-server', '-c', 'hooks={}']]])(
    'plays the scenario as an app-server when started with %j',
    async (args) => {
      expect(await playPrompt(startFake('echo', {}, args))).toMatchObject([
        turnStartResponse,
        turnStarted,
        ...message('message-1', 'Hello sandbox', ['Hello sandbox']),
        turnCompleted('completed'),
      ]);
    }
  );
});

describe('fake Codex behind the bundled adapter', () => {
  const run = promisify(execFile);
  let directory = '';
  afterEach(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
      directory = '';
    }
  });

  // The application's health check runs these two commands; each must answer, not hang.
  it('answers the health check version and login commands', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ff-fake-codex-cli-'));
    const codexPath = join(directory, 'codex');
    await copyFile(fakePath, codexPath);
    await chmod(codexPath, 0o755);
    const env = {
      PATH: process.env.PATH ?? '',
      CODEX_PATH: codexPath,
      FF_SANDBOX_SCENARIO: 'echo',
    };
    const version = getBundledCodexCommand(['--version']);
    expect(await run(version.command, version.args, { env })).toEqual({
      stdout: fakeVersion,
      stderr: '',
    });
    const login = getBundledCodexCommand(['login', 'status']);
    expect(await run(login.command, login.args, { env })).toEqual({
      stdout: '',
      stderr: 'Logged in using ChatGPT\n',
    });
  }, 30_000);
});
