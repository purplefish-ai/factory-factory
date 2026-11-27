import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const fakePath = fileURLToPath(new URL('./fake-claude-cli.mjs', import.meta.url));
const sessionId = '11111111-1111-4111-8111-111111111111';
const streamArgs = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--input-format',
  'stream-json',
  '--permission-mode=default',
  `--session-id=${sessionId}`,
  '--replay-user-messages',
];
const messageSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  request_id: z.string().optional(),
  request: z.looseObject({ subtype: z.string() }).optional(),
  response: z.looseObject({ subtype: z.string(), request_id: z.string() }).optional(),
});
type Message = z.infer<typeof messageSchema>;

const children: ChildProcessWithoutNullStreams[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ff-fake-claude-')));
  directories.push(directory);
  return directory;
}

/** The environment the sandbox gives the fake: config dir and call log in a temp directory. */
function sandboxEnv(extra: Record<string, string> = {}) {
  const dir = temporary();
  return {
    dir,
    log: join(dir, 'claude-calls.log'),
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: tmpdir(),
      CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
      FF_SANDBOX_CLAUDE_LOG: join(dir, 'claude-calls.log'),
      ...extra,
    },
  };
}

const run = promisify(execFile);

/** A stream-json session with the fake; `next` waits for the first message matching `test`. */
function startSession(env: Record<string, string>, args = streamArgs) {
  const child = spawn(process.execPath, [fakePath, ...args], { env });
  children.push(child);
  const messages: Message[] = [];
  const waiters: Array<{ test: (message: Message) => boolean; resolve: (m: Message) => void }> = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = messageSchema.parse(JSON.parse(line));
    messages.push(message);
    for (const waiter of waiters.splice(0)) {
      if (waiter.test(message)) {
        waiter.resolve(message);
      } else {
        waiters.push(waiter);
      }
    }
  });
  const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    child,
    messages,
    write,
    next(test: (message: Message) => boolean) {
      const found = messages.find(test);
      return found
        ? Promise.resolve(found)
        : new Promise<Message>((resolve) => waiters.push({ test, resolve }));
    },
    async control(subtype: string, payload: Record<string, unknown> = {}) {
      const requestId = `sdk-${subtype}-${messages.length}`;
      write({ type: 'control_request', request_id: requestId, request: { subtype, ...payload } });
      const reply = await this.next(
        (message) =>
          message.type === 'control_response' && message.response?.request_id === requestId
      );
      return reply.response as { subtype: string; response?: Record<string, unknown> };
    },
    prompt(text: string) {
      write({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        session_id: sessionId,
        parent_tool_use_id: null,
        uuid: `user-${messages.length}`,
      });
      return this.next((message) => message.type === 'result');
    },
  };
}

const hooks = {
  PreToolUse: [{ hookCallbackIds: ['pre-1'] }],
  PostToolUse: [{ hookCallbackIds: ['post-1', 'post-2'] }],
  PostCompact: [{ hookCallbackIds: ['compact-1'] }],
};

/** Answers every hook with `continue` and every permission request with `behavior`. */
function answerRequests(session: ReturnType<typeof startSession>, behavior: 'allow' | 'deny') {
  const seen = new Set<string>();
  const answer = () => {
    for (const message of session.messages) {
      if (
        message.type !== 'control_request' ||
        !message.request_id ||
        seen.has(message.request_id)
      ) {
        continue;
      }
      seen.add(message.request_id);
      const response =
        message.request?.subtype === 'can_use_tool'
          ? behavior === 'allow'
            ? { behavior, updatedInput: message.request.input }
            : { behavior, message: 'The user said no.' }
          : { continue: true };
      session.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response },
      });
    }
  };
  session.child.stdout.on('data', () => setImmediate(answer));
}

const textOf = (messages: Message[]) =>
  messages.flatMap((message) => {
    const content = (message as { message?: { content?: unknown } }).message?.content;
    return message.type === 'assistant' && Array.isArray(content)
      ? content.flatMap((block: { type: string; text?: string }) =>
          block.type === 'text' && block.text ? [block.text] : []
        )
      : [];
  });

describe('the command line', () => {
  it('answers the version and sign-in checks without a session, and logs each call', async () => {
    const { env, log, dir } = sandboxEnv();
    const version = await run(process.execPath, [fakePath, '--version'], { env });
    expect(version.stdout).toBe('2.1.312 (Claude Code)\n');
    const status = await run(process.execPath, [fakePath, 'auth', 'status', '--json'], { env });
    expect(JSON.parse(status.stdout)).toMatchObject({
      loggedIn: true,
      configDirectory: join(dir, 'claude-config'),
    });
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.argv)).toEqual([['--version'], ['auth', 'status', '--json']]);
  });

  it('refuses to run unless the config directory and call log are in the temp directory', async () => {
    const { env } = sandboxEnv();
    for (const unsafe of [
      { CLAUDE_CONFIG_DIR: '' },
      { CLAUDE_CONFIG_DIR: join(homedir(), '.claude') },
      { FF_SANDBOX_CLAUDE_LOG: join(homedir(), 'claude-calls.log') },
    ]) {
      await expect(
        run(process.execPath, [fakePath, '--version'], { env: { ...env, ...unsafe } })
      ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('fake Claude CLI') });
    }
    expect(existsSync(join(homedir(), 'claude-calls.log'))).toBe(false);
  });

  it('fails other command lines, an unknown scenario and a resume at once', async () => {
    const { env } = sandboxEnv();
    await expect(run(process.execPath, [fakePath, '-p', 'hello'], { env })).rejects.toMatchObject({
      code: 2,
    });
    await expect(
      run(process.execPath, [fakePath, '--version'], {
        env: { ...env, FF_SANDBOX_SCENARIO: 'nope' },
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Valid scenarios: echo, permission-request'),
    });
    await expect(
      run(process.execPath, [fakePath, ...streamArgs, `--resume=${sessionId}`], { env })
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`No conversation found with session ID: ${sessionId}`),
    });
  });
});

describe('a stream-json session', () => {
  it('answers initialize with models and the account, and the SDK reads', async () => {
    const session = startSession(sandboxEnv().env);
    const init = await session.control('initialize', { hooks });
    expect(init.subtype).toBe('success');
    expect(init.response).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ value: 'sonnet', displayName: 'Sonnet 5.5' }),
      ]),
      account: expect.objectContaining({ email: 'sandbox@factory-factory.invalid' }),
    });
    expect((await session.control('set_model', { model: 'sonnet' })).response).toEqual({
      model: 'claude-sonnet-5-5',
    });
    expect((await session.control('get_usage')).response).toMatchObject({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 12 } },
    });
    expect((await session.control('get_context_usage')).response).toMatchObject({
      maxTokens: 200_000,
    });
    expect(await session.control('no_such_request')).toMatchObject({ subtype: 'error' });
  });

  it('echoes a prompt with the recorded message sequence', async () => {
    const session = startSession(sandboxEnv({ FF_SANDBOX_SCENARIO: 'echo' }).env);
    await session.control('initialize', { hooks });
    const result = await session.prompt('Hello sandbox');
    expect(result).toMatchObject({ subtype: 'success', is_error: false, result: 'Hello sandbox' });
    const sequence = session.messages
      .filter((message) => message.type !== 'control_response')
      .map((message) => {
        const event = (message as { event?: { type: string } }).event;
        return [message.type, message.subtype ?? event?.type].filter(Boolean).join(' ');
      });
    expect(sequence).toEqual([
      'system session_state_changed',
      'command_lifecycle',
      'command_lifecycle',
      'system init',
      'user',
      'system status',
      'stream_event message_start',
      'stream_event content_block_start',
      // "Hello " and "sandbox": a reply streams in up to three chunks, split at spaces.
      'stream_event content_block_delta',
      'stream_event content_block_delta',
      'assistant',
      'stream_event content_block_stop',
      'stream_event message_delta',
      'stream_event message_stop',
      'result success',
      'command_lifecycle',
      'system session_state_changed',
    ]);
    expect(session.messages.find((message) => message.type === 'user')).toMatchObject({
      isReplay: true,
      session_id: sessionId,
    });
  });

  it('asks before Bash, calls the hooks, and runs it when allowed', async () => {
    const session = startSession(sandboxEnv().env);
    await session.control('initialize', { hooks });
    answerRequests(session, 'allow');
    const result = await session.prompt('ff-scenario:permission-request');
    expect(result).toMatchObject({ subtype: 'success', permission_denials: [] });
    const requests = session.messages.flatMap((message) =>
      message.type === 'control_request' ? [message.request] : []
    );
    expect(requests.map((request) => [request?.subtype, request?.callback_id])).toEqual([
      ['hook_callback', 'pre-1'],
      ['can_use_tool', undefined],
      ['hook_callback', 'post-1'],
      ['hook_callback', 'post-2'],
    ]);
    expect(requests[1]).toMatchObject({
      tool_name: 'Bash',
      input: { command: 'echo "Hello from the sandbox"' },
    });
    const toolResult = session.messages.find(
      (message) => message.type === 'user' && 'tool_use_result' in message
    );
    expect(toolResult).toMatchObject({
      message: { content: [{ type: 'tool_result', content: 'Hello from the sandbox' }] },
    });
    expect(textOf(session.messages)).toEqual(['You approved the command, so I ran it.']);
  });

  it('goes on without Bash when the permission is denied', async () => {
    const session = startSession(sandboxEnv().env);
    await session.control('initialize', { hooks });
    answerRequests(session, 'deny');
    const result = await session.prompt('ff-scenario:permission-request');
    expect(result).toMatchObject({
      permission_denials: [expect.objectContaining({ tool_name: 'Bash' })],
    });
    const subtypes = session.messages.flatMap((message) =>
      message.type === 'control_request' ? [message.request?.subtype] : []
    );
    expect(subtypes).toEqual(['hook_callback', 'can_use_tool']);
    expect(textOf(session.messages)).toEqual(['You declined the command, so I did not run it.']);
  });

  it('ends a turn waiting for permission when interrupted', async () => {
    const session = startSession(sandboxEnv().env);
    await session.control('initialize', { hooks: {} });
    const result = session.prompt('ff-scenario:permission-request');
    await session.next((message) => message.request?.subtype === 'can_use_tool');
    expect((await session.control('interrupt')).subtype).toBe('success');
    expect(await result).toMatchObject({ subtype: 'error_during_execution', is_error: true });
  });

  it('fails a turn that names an unknown scenario', async () => {
    const session = startSession(sandboxEnv().env);
    await session.control('initialize', { hooks: {} });
    expect(await session.prompt('ff-scenario:nope')).toMatchObject({
      is_error: true,
      result: 'Unknown scenario "nope". Valid scenarios: echo, permission-request',
    });
  });

  it('answers a JSON schema session with structured output', async () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 100 },
        branch: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
        sidebarSummary: { type: 'string', maxLength: 120 },
      },
    };
    const session = startSession(sandboxEnv().env, [
      ...streamArgs,
      `--json-schema=${JSON.stringify(schema)}`,
    ]);
    await session.control('initialize', { hooks: {} });
    expect(await session.prompt('ff-scenario:permission-request')).toMatchObject({
      subtype: 'success',
      structured_output: {
        title: 'Sandbox title',
        branch: 'sandbox-branch',
        sidebarSummary: 'Sandbox sidebar summary',
      },
    });
  });

  it('exits once its input ends', async () => {
    const session = startSession(sandboxEnv().env);
    await session.control('initialize', { hooks: {} });
    const exited = once(session.child, 'exit');
    session.child.stdin.end();
    expect((await exited)[0]).toBe(0);
  });
});
