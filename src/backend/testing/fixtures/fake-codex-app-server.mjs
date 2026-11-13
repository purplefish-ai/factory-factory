#!/usr/bin/env node
// Synthetic app-server for testing the published ACP executable without inference.
// FF_SANDBOX_SCENARIO selects what a prompt plays (see `scenarios`); unset keeps
// the contract reply. Self-contained: tests copy this one file into a temp dir.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const nativeId = '11111111-1111-4111-8111-111111111111';
const thread = {
  id: nativeId,
  cwd: process.cwd(),
  turns: [],
  historyMode: 'legacy',
  status: { type: 'idle' },
  source: 'cli',
  modelProvider: 'openai',
  createdAt: 0,
  updatedAt: 0,
  preview: 'Synthetic conversation',
};
const model = {
  id: 'contract-model',
  model: 'contract-model',
  displayName: 'Contract model',
  description: 'Synthetic model',
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
  inputModalities: ['text', 'image'],
  supportsPersonality: false,
};
const slowStreamChunks = ['Streaming ', 'this ', 'reply ', 'one ', 'chunk ', 'at ', 'a ', 'time.'];
const slowStreamDelayMs = 400;
const scenarios = {
  echo: async (turn) => {
    const text = turn.input.flatMap((input) => (input.type === 'text' ? [input.text] : []));
    await turn.reply([text.join('\n') || '(The prompt had no text.)']);
  },
  // An unparsed shell command, not a `read` action: the adapter drops a read's output for this
  // app's client identity (AIR), so a read would reach the transcript without its result.
  'tool-call': async (turn) => {
    const command = 'cat README.md';
    const output = 'Scripted README.md contents from the fake provider.\n';
    turn.command('tool-call-command', command, [{ type: 'unknown', command }], output);
    await turn.reply(['I ran cat README.md; it printed one line of scripted text.']);
  },
  'permission-request': async (turn) => {
    const command = 'echo "Hello from the sandbox"';
    const actions = [{ type: 'unknown', command }];
    const { decision } = await turn.request('item/commandExecution/requestApproval', {
      kind: 'command',
      threadId: turn.threadId,
      turnId: turn.id,
      itemId: 'approval-command',
      startedAtMs: Date.now(),
      environmentId: null,
      reason: 'The sandbox scenario asks before running a harmless command.',
      command,
      cwd: turn.cwd,
      commandActions: actions,
    });
    if (decision === 'accept' || decision === 'acceptForSession') {
      turn.command('approval-command', command, actions, 'Hello from the sandbox\n');
      await turn.reply(['You approved the command, so I ran it.']);
    } else {
      await turn.reply(['You declined the command, so I did not run it.']);
    }
  },
  error: (turn) => {
    const error = {
      message: 'Sandbox scenario error: the fake provider failed this turn on purpose.',
      codexErrorInfo: null,
      additionalDetails: null,
      misalignment: null,
    };
    turn.notify('error', { error, willRetry: false, threadId: turn.threadId, turnId: turn.id });
    return { status: 'failed', error };
  },
  'slow-stream': async (turn) => {
    await turn.reply(slowStreamChunks, slowStreamDelayMs);
  },
};
const scenarioName = process.env.FF_SANDBOX_SCENARIO;
if (scenarioName !== undefined && !Object.hasOwn(scenarios, scenarioName)) {
  process.stderr.write(
    `Unknown FF_SANDBOX_SCENARIO "${scenarioName}". Valid scenarios: ${Object.keys(scenarios).join(', ')}\n`
  );
  process.exit(2);
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ method, params });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingServerRequests = new Map();
const interrupts = new Map();
let serverRequestCount = 0;

/** Plays the selected scenario as one turn, with the item shapes of the Codex app-server protocol. */
async function playScenario(request, turnId) {
  const threadId = request.params.threadId;
  const baseTurn = {
    id: turnId,
    rootTurnId: null,
    items: [],
    itemsView: 'notLoaded',
    status: 'inProgress',
    error: null,
    startedAt: 0,
    completedAt: null,
    durationMs: null,
  };
  const item = (method, value) =>
    notify(method, {
      item: value,
      threadId,
      turnId,
      [method === 'item/started' ? 'startedAtMs' : 'completedAtMs']: Date.now(),
    });
  const cwd = request.params.cwd ?? thread.cwd;
  let messageCount = 0;
  // turn/interrupt stops the scenario: no further items, and an open approval is cancelled.
  let interrupted = false;
  interrupts.set(turnId, () => {
    interrupted = true;
    for (const resolve of pendingServerRequests.values()) {
      resolve({ decision: 'cancel' });
    }
    pendingServerRequests.clear();
  });
  const turn = {
    id: turnId,
    threadId,
    cwd,
    input: request.params.input ?? [],
    notify,
    request(method, params) {
      const id = `fake-server-request-${++serverRequestCount}`;
      send({ id, method, params });
      return new Promise((resolve) => pendingServerRequests.set(id, resolve));
    },
    async reply(chunks, delayMs = 0) {
      if (interrupted) {
        return;
      }
      const id = `message-${++messageCount}`;
      const message = { type: 'agentMessage', id, phase: null, memoryCitation: null };
      const fields = { ...message, delivery: null, questions: null };
      item('item/started', { ...fields, text: '' });
      const sent = [];
      for (const delta of chunks) {
        if (sent.length > 0) {
          await sleep(delayMs);
        }
        if (interrupted) {
          break;
        }
        sent.push(delta);
        notify('item/agentMessage/delta', { threadId, turnId, itemId: id, delta });
      }
      item('item/completed', { ...fields, text: sent.join('') });
    },
    command(id, command, commandActions, output) {
      const base = { type: 'commandExecution', id, command, cwd, commandActions };
      const fields = {
        ...base,
        processId: null,
        source: 'agent',
        pluginId: null,
        scriptPath: null,
      };
      item('item/started', {
        ...fields,
        status: 'inProgress',
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      });
      notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: id, delta: output });
      item('item/completed', {
        ...fields,
        status: 'completed',
        aggregatedOutput: output,
        exitCode: 0,
        durationMs: 1,
      });
    },
  };
  notify('turn/started', { threadId, turn: baseTurn });
  const played = (await scenarios[scenarioName](turn)) ?? { status: 'completed', error: null };
  interrupts.delete(turnId);
  const ending = interrupted ? { status: 'interrupted', error: null } : played;
  notify('turn/completed', {
    threadId,
    turn: { ...baseTurn, ...ending, completedAt: 0, durationMs: 0 },
  });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (process.env.FF_ACP_PROBE_LOG) {
    appendFileSync(process.env.FF_ACP_PROBE_LOG, `${line}\n`);
  }
  if (!Object.hasOwn(request, 'id')) {
    return;
  }
  if (!Object.hasOwn(request, 'method')) {
    pendingServerRequests.get(request.id)?.(request.result ?? {});
    pendingServerRequests.delete(request.id);
    return;
  }
  let result = {};
  switch (request.method) {
    case 'initialize':
      result = { userAgent: 'synthetic', codexHome: process.env.CODEX_HOME };
      break;
    case 'account/read':
      result = { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
      break;
    case 'config/read':
      result = { config: {}, layers: [] };
      break;
    case 'model/list':
      result = { data: [model], nextCursor: null };
      break;
    case 'skills/list':
      result = { data: [] };
      break;
    case 'thread/start':
      result = {
        thread: request.params.ephemeral ? { ...thread, id: 'title-thread' } : thread,
        model: model.id,
        modelProvider: 'openai',
        approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
        reasoningEffort: 'medium',
        serviceTier: null,
      };
      break;
    case 'thread/resume':
      if (request.params.threadId !== nativeId) {
        send({ id: request.id, error: { code: -32_602, message: 'Unknown synthetic thread' } });
        return;
      }
      result = {
        thread,
        model: model.id,
        modelProvider: 'openai',
        approvalPolicy: 'on-request',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: 'medium',
        materialized: true,
        collaborationMode: 'default',
      };
      break;
    case 'thread/read':
      result = { thread };
      break;
    case 'thread/goal/get':
      result = { goal: null };
      break;
    case 'turn/interrupt':
      interrupts.get(request.params.turnId)?.();
      break;
    case 'mcpServerStatus/list':
      result = { data: [], nextCursor: null };
      break;
    case 'turn/start': {
      const turn = { id: `turn-${request.id}`, status: 'inProgress', items: [], error: null };
      const threadId = request.params.threadId;
      send({ id: request.id, result: { turn } });
      // Ephemeral title threads keep the contract reply, so only the conversation plays a scenario.
      if (scenarioName !== undefined && threadId === nativeId) {
        setTimeout(() => void playScenario(request, turn.id), 5);
        return;
      }
      setTimeout(() => {
        const targetedStopContract = request.params.input?.some(
          (input) => input.text === 'Synthetic targeted stop contract'
        );
        if (targetedStopContract) {
          send({
            method: 'item/started',
            params: {
              threadId,
              turnId: turn.id,
              item: {
                id: 'child-activity',
                type: 'subAgentActivity',
                kind: 'started',
                agentThreadId: '22222222-2222-4222-8222-222222222222',
                agentPath: '/root/Worker',
              },
            },
          });
          send({
            method: 'turn/completed',
            params: {
              threadId: '22222222-2222-4222-8222-222222222222',
              turn: { id: 'child-turn', status: 'completed', items: [], error: null },
            },
          });
        }
        send({
          method: 'item/started',
          params: {
            threadId,
            turnId: turn.id,
            item: { id: 'message', type: 'agentMessage', text: '' },
          },
        });
        send({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId: turn.id, itemId: 'message', delta: 'Synthetic response' },
        });
        send({
          method: 'item/completed',
          params: {
            threadId,
            turnId: turn.id,
            item: { id: 'message', type: 'agentMessage', text: 'Synthetic response' },
          },
        });
        send({
          method: 'turn/completed',
          params: { threadId, turn: { ...turn, status: 'completed' } },
        });
      }, 5);
      return;
    }
  }
  send({ id: request.id, result });
});
