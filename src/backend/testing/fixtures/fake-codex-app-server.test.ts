import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

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

function startFake(scenario?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (scenario !== undefined) {
    env.FF_SANDBOX_SCENARIO = scenario;
  }
  const child = spawn(process.execPath, [fakePath], { env });
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

  it('slow-stream sends one reply in several deltas', async () => {
    const chunks = ['Streaming ', 'this ', 'reply ', 'one ', 'chunk ', 'at ', 'a ', 'time.'];
    expect(await playPrompt(startFake('slow-stream'))).toMatchObject([
      turnStartResponse,
      turnStarted,
      ...message('message-1', chunks.join(''), chunks),
      turnCompleted('completed'),
    ]);
  }, 10_000);

  it('slow-stream stops streaming on turn/interrupt', async () => {
    const [started, delta, completed] = message('message-1', 'Streaming ', ['Streaming ']);
    expect(
      await playPrompt(startFake('slow-stream'), { interruptOn: 'item/agentMessage/delta' })
    ).toMatchObject([
      turnStartResponse,
      turnStarted,
      started,
      delta,
      { id: 8, result: {} },
      completed,
      turnCompleted('interrupted'),
    ]);
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
      `Unknown FF_SANDBOX_SCENARIO "${name}". Valid scenarios: echo, permission-request, error, slow-stream\n`
    );
  });
});
