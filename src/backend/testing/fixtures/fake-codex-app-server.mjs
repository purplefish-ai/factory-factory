#!/usr/bin/env node
// Synthetic app-server for testing the published ACP executable without inference.
// Self-contained: tests copy this one file into a temp dir.
//
// Choosing a scenario (see `scenarios`). A prompt containing `ff-scenario:<name>` plays that
// scenario; `ff-scenario:<name>:<argument>` also passes an argument (letters, digits, `_`, `-`).
// Each prompt is read on its own, so every turn of a conversation can choose. A prompt without
// the token plays FF_SANDBOX_SCENARIO (the sandbox sets `echo`); with neither, the fake sends the
// contract reply. An unknown name in a prompt fails that turn, naming the valid ones; an unknown
// FF_SANDBOX_SCENARIO stops the process. Title threads (ephemeral) always get the contract reply.
//
// Releasing a gate. `ff-scenario:gated-stream:<gate>` streams a first chunk, then waits until the
// file `<FF_SANDBOX_GATE_DIR>/<gate>` exists, deletes it and streams the rest. A file created
// before the turn reaches the gate releases it at once. The sandbox sets FF_SANDBOX_GATE_DIR to
// `<baseDir>/gates` (`gateDir` in scripts/sandbox/paths.mjs).
//
// History. Each thread/start issues a new UUIDv7 thread id. With CODEX_HOME set, a conversation is
// appended, from its first prompt as Codex does, to
// `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<UTC time>-<thread id>.jsonl`, and thread/resume and
// thread/read find it there after a restart. A turn on a thread this process neither started nor
// resumed fails, as in Codex; without CODEX_HOME such a thread is adopted. The line shapes are copied from the fixtures in
// codex-session-history-loader.service.test.ts until a recorded Codex session replaces them.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const codexHome = process.env.CODEX_HOME?.trim() || null;
const gateDir = process.env.FF_SANDBOX_GATE_DIR?.trim() || null;
// How often a waiting gate looks for its file.
const gatePollMs = 50;
const scenarioToken = /\bff-scenario:([a-z][a-z-]*)(?::([\w-]+))?/;
const processNonce = randomBytes(4).toString('hex');

/** A UUIDv7, whose first 48 bits are the creation time: the loader finds its date directory. */
function uuidV7(timeMs) {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(timeMs, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Every thread this process knows: { id, cwd, ephemeral, rollout (a path, or null) }.
const threads = new Map();

function rolloutPath(id, timeMs) {
  const iso = new Date(timeMs).toISOString();
  const [year, month, day] = iso.slice(0, 10).split('-');
  const stamp = iso.slice(0, 19).replaceAll(':', '-');
  return join(codexHome, 'sessions', year, month, day, `rollout-${stamp}-${id}.jsonl`);
}

function addThread(id, cwd, ephemeral = false) {
  const record = {
    id,
    cwd,
    ephemeral,
    // Codex keeps no rollout for an ephemeral thread.
    rollout: codexHome && !ephemeral ? rolloutPath(id, Date.now()) : null,
  };
  threads.set(id, record);
  return record;
}

/** A thread from this process, or one an earlier process wrote a rollout for. */
function findThread(id) {
  const known = threads.get(id);
  if (known || !codexHome || !existsSync(join(codexHome, 'sessions'))) {
    return known ?? null;
  }
  const sessions = join(codexHome, 'sessions');
  const file = readdirSync(sessions, { recursive: true }).find(
    (name) => typeof name === 'string' && basename(name).endsWith(`-${id}.jsonl`)
  );
  if (file === undefined) {
    return null;
  }
  const rollout = join(sessions, file);
  const meta = JSON.parse(readFileSync(rollout, 'utf8').split('\n')[0]);
  const record = { id, cwd: meta.payload.cwd, ephemeral: false, rollout };
  threads.set(id, record);
  return record;
}

/** Appends one rollout line, after the session_meta line that opens a new file. */
function record(thread, type, payload) {
  if (!thread.rollout) {
    return;
  }
  const lines = [];
  if (!existsSync(thread.rollout)) {
    mkdirSync(dirname(thread.rollout), { recursive: true });
    lines.push({ type: 'session_meta', payload: { id: thread.id, cwd: thread.cwd } });
  }
  lines.push({ timestamp: new Date().toISOString(), type, payload });
  appendFileSync(thread.rollout, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

const turnShape = (id) => ({
  id,
  rootTurnId: null,
  items: [],
  itemsView: 'notLoaded',
  status: 'inProgress',
  error: null,
  startedAt: 0,
  completedAt: null,
  durationMs: null,
});

/** A commandExecution item that ran `command` to `output`, as the scenarios run one. */
function commandItem(id, command, cwd, output) {
  return {
    type: 'commandExecution',
    id,
    command,
    cwd,
    commandActions: [{ type: 'unknown', command }],
    processId: null,
    source: 'agent',
    pluginId: null,
    scriptPath: null,
    status: 'completed',
    aggregatedOutput: output,
    exitCode: 0,
    durationMs: 1,
  };
}

/** The recorded turns (prompts, replies, commands) for thread/read with includeTurns. */
function readTurns(thread) {
  if (!(thread.rollout && existsSync(thread.rollout))) {
    return [];
  }
  const turns = [];
  for (const line of readFileSync(thread.rollout, 'utf8').split('\n')) {
    const { type, payload } = line ? JSON.parse(line) : {};
    if (type === 'event_msg' && payload.type === 'task_started') {
      // The rollout records no turn ending, and a turn replayed after a restart has ended.
      const done = { status: 'completed', completedAt: 0, durationMs: 0 };
      turns.push({ ...turnShape(payload.turn_id), ...done, itemsView: 'full' });
    }
    const turn = turns.at(-1);
    if (!(turn && payload)) {
      continue;
    }
    const id = `${turn.id}-item-${turn.items.length + 1}`;
    if (type === 'event_msg' && payload.type === 'user_message') {
      const content = [{ type: 'text', text: payload.message, text_elements: [] }];
      turn.items.push({ type: 'userMessage', id, content });
    } else if (type === 'event_msg' && payload.type === 'agent_message') {
      const message = { type: 'agentMessage', id, text: payload.message };
      turn.items.push({ ...message, phase: null, memoryCitation: null });
    } else if (type === 'response_item' && payload.type === 'function_call') {
      const { cmd } = JSON.parse(payload.arguments);
      turn.items.push(commandItem(payload.call_id, cmd, thread.cwd, null));
    } else if (type === 'response_item' && payload.type === 'function_call_output') {
      const command = turn.items.find((item) => item.id === payload.call_id);
      if (command) {
        command.aggregatedOutput = payload.output;
      }
    }
  }
  return turns;
}

function threadShape(thread, turns = []) {
  return {
    id: thread.id,
    cwd: thread.cwd,
    turns,
    historyMode: 'legacy',
    status: { type: 'idle' },
    source: 'cli',
    modelProvider: 'openai',
    createdAt: 0,
    updatedAt: 0,
    preview: 'Synthetic conversation',
  };
}

const promptText = (input = []) =>
  input.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n');

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
function retryConnection(turn, attempt, willRetry = true) {
  const error = {
    message: willRetry
      ? `Reconnecting... ${attempt}/5`
      : 'The scripted response stream disconnected.',
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    additionalDetails: null,
  };
  turn.notify('error', { error, willRetry, threadId: turn.threadId, turnId: turn.id });
  return error;
}

async function playRetries(turn) {
  retryConnection(turn, 1);
  if (!(await turn.wait(100))) {
    return false;
  }
  retryConnection(turn, 2);
  return turn.wait(chunkDelayMs);
}

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
    turn.command('tool-call-command', command, output);
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
      turn.command('approval-command', command, 'Hello from the sandbox\n');
      await turn.reply(['You approved the command, so I ran it.']);
    } else {
      await turn.reply(['You declined the command, so I did not run it.']);
    }
  },
  'async-question': async (turn) => {
    const question = 'Does the [preview](README.md) look ready?';
    const answer = new Promise((resolve) => pendingSteers.set(turn.id, resolve));
    turn.notify('item/completed', {
      threadId: turn.threadId,
      turnId: turn.id,
      completedAtMs: Date.now(),
      item: {
        type: 'agentMessage',
        id: 'async-preview-question',
        text: question,
        phase: 'commentary',
        memoryCitation: null,
        delivery: 'async',
        questions: [{ title: question, options: ['Approve wording', 'Revise wording'] }],
      },
    });
    await turn.reply(['I am still working while you review.']);
    const input = await Promise.race([answer, turn.wait(60_000)]);
    pendingSteers.delete(turn.id);
    if (Array.isArray(input) && input.some(({ text }) => text?.includes('Approve wording'))) {
      await turn.reply(['The async answer reached Codex.']);
    }
  },
  error: (turn) =>
    turn.fail('Sandbox scenario error: the fake provider failed this turn on purpose.'),
  'retry-recover': async (turn) => {
    if (await playRetries(turn)) {
      await turn.reply(['The scripted response resumed.']);
    }
  },
  'retry-fail': async (turn) => {
    if (await playRetries(turn)) {
      return { status: 'failed', error: retryConnection(turn, 2, false) };
    }
  },
  'slow-stream': async (turn) => {
    await turn.reply(slowStreamChunks, chunkDelayMs);
  },
  // Stays in progress until its gate file appears (see the top of this file), or a stop.
  'gated-stream': async (turn) => {
    const gate = turn.argument;
    if (!gate) {
      return turn.fail('gated-stream needs a gate name: ff-scenario:gated-stream:<gate>.');
    }
    if (!gateDir) {
      return turn.fail('gated-stream needs FF_SANDBOX_GATE_DIR, the directory of gate files.');
    }
    await turn.reply([`Waiting at gate ${gate}. `, `Gate ${gate} released.`], () =>
      turn.gate(join(gateDir, gate))
    );
  },
};
const scenarioName = process.env.FF_SANDBOX_SCENARIO;
if (scenarioName !== undefined && !Object.hasOwn(scenarios, scenarioName)) {
  process.stderr.write(
    `Unknown FF_SANDBOX_SCENARIO "${scenarioName}". Valid scenarios: ${Object.keys(scenarios).join(', ')}\n`
  );
  process.exit(2);
}
// Tests set FF_SANDBOX_CHUNK_DELAY_MS: short to check order and count, or longer than the test
// so that a stop is never raced by the next chunk.
const delayOverride = process.env.FF_SANDBOX_CHUNK_DELAY_MS;
if (
  delayOverride !== undefined &&
  !(/^[1-9]\d*$/.test(delayOverride) && +delayOverride < 2 ** 31)
) {
  process.stderr.write(
    `Invalid FF_SANDBOX_CHUNK_DELAY_MS "${delayOverride}": expected a positive whole number of milliseconds.\n`
  );
  process.exit(2);
}
const chunkDelayMs = delayOverride === undefined ? slowStreamDelayMs : Number(delayOverride);

/**
 * The command line, answered the way the real `codex` binary answers it. The application runs
 * `-V` for its version check (it keeps the first stdout line), `login status` (it reads only the
 * exit code) and `app-server` for sessions, accounts and plan usage; the adapter adds
 * `-c hooks=…` when hooks are configured. No arguments also starts the app-server: tests and
 * the sandbox's scenario check run it that way. Any other form (interactive `login`, `exec` for
 * disposable inference) fails at once; it never waits on stdin. Returns null for the app-server.
 */
function answerCommandLine(args) {
  if (args.length === 1 && (args[0] === '-V' || args[0] === '--version')) {
    return { stream: process.stdout, text: 'codex-cli 0.0.0-fake\n', code: 0 };
  }
  if (args.length === 2 && args[0] === 'login' && args[1] === 'status') {
    // A scripted stand-in with no account reports a logged-in state only so that the
    // application's health check lets a session start. It holds and reads no credential.
    return { stream: process.stderr, text: 'Logged in using ChatGPT\n', code: 0 };
  }
  const appServerOptions = args.slice(1);
  const isAppServer =
    args.length === 0 ||
    (args[0] === 'app-server' &&
      appServerOptions.length % 2 === 0 &&
      appServerOptions.every((arg, index) => (index % 2 === 0 ? arg === '-c' : arg !== '')));
  if (isAppServer) {
    return null;
  }
  return {
    stream: process.stderr,
    text: `fake Codex: unsupported arguments: ${args.join(' ')}\n`,
    code: 2,
  };
}
const commandLineAnswer = answerCommandLine(process.argv.slice(2));
if (commandLineAnswer) {
  // exitCode, not exit(): a pipe write may still be pending on macOS.
  commandLineAnswer.stream.write(commandLineAnswer.text);
  process.exitCode = commandLineAnswer.code;
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ method, params });
const pendingServerRequests = new Map();
const interrupts = new Map();
const pendingSteers = new Map();
let serverRequestCount = 0;

/**
 * The scenario a prompt plays: its own `ff-scenario:` token, else FF_SANDBOX_SCENARIO, else null
 * for the contract reply. An unknown name in the prompt plays a failure that names the valid ones.
 */
function chooseScenario(text) {
  const [, name, argument] = scenarioToken.exec(text) ?? [];
  if (name === undefined) {
    return scenarioName === undefined ? null : { play: scenarios[scenarioName] };
  }
  if (!Object.hasOwn(scenarios, name)) {
    const valid = Object.keys(scenarios).join(', ');
    return { play: (turn) => turn.fail(`Unknown scenario "${name}". Valid scenarios: ${valid}`) };
  }
  return { play: scenarios[name], argument };
}

/** Plays a scenario as one turn, with the item shapes of the Codex app-server protocol. */
async function playScenario(request, turnId, thread, scenario) {
  const threadId = request.params.threadId;
  const baseTurn = turnShape(turnId);
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
  let wake = () => undefined;
  // Unref'd so a pending chunk never keeps the fake alive once stdin closes; an interrupt wakes it.
  const sleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  interrupts.set(turnId, () => {
    interrupted = true;
    wake();
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
    argument: scenario.argument,
    notify,
    async wait(ms) {
      if (!interrupted) {
        await sleep(ms);
      }
      return !interrupted;
    },
    /** Waits until `file` exists, then deletes it; returns false if the turn stops first. */
    async gate(file) {
      while (!interrupted) {
        if (existsSync(file)) {
          rmSync(file, { force: true });
          return true;
        }
        await sleep(gatePollMs);
      }
      return false;
    },
    /** Ends the turn as failed with a visible error. */
    fail(message) {
      const error = { message, codexErrorInfo: null, additionalDetails: null, misalignment: null };
      notify('error', { error, willRetry: false, threadId, turnId });
      return { status: 'failed', error };
    },
    request(method, params) {
      const id = `fake-server-request-${++serverRequestCount}`;
      send({ id, method, params });
      return new Promise((resolve) => pendingServerRequests.set(id, resolve));
    },
    /** One message in `chunks`; between two chunks, sleeps `pause` ms or awaits `pause()`. */
    async reply(chunks, pause = 0) {
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
          await (typeof pause === 'function' ? pause() : sleep(pause));
        }
        if (interrupted) {
          break;
        }
        sent.push(delta);
        notify('item/agentMessage/delta', { threadId, turnId, itemId: id, delta });
      }
      item('item/completed', { ...fields, text: sent.join('') });
      record(thread, 'event_msg', { type: 'agent_message', message: sent.join('') });
    },
    command(id, command, output) {
      const completed = commandItem(id, command, cwd, output);
      const running = { status: 'inProgress', aggregatedOutput: null, exitCode: null };
      item('item/started', { ...completed, ...running, durationMs: null });
      notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: id, delta: output });
      item('item/completed', completed);
      const call = {
        name: 'exec_command',
        call_id: id,
        arguments: JSON.stringify({ cmd: command }),
      };
      record(thread, 'response_item', { type: 'function_call', ...call });
      record(thread, 'response_item', { type: 'function_call_output', call_id: id, output });
    },
  };
  notify('turn/started', { threadId, turn: baseTurn });
  const played = (await scenario.play(turn)) ?? { status: 'completed', error: null };
  interrupts.delete(turnId);
  const ending = interrupted ? { status: 'interrupted', error: null } : played;
  notify('turn/completed', {
    threadId,
    turn: { ...baseTurn, ...ending, completedAt: 0, durationMs: 0 },
  });
}

const appServerInput = commandLineAnswer ? null : createInterface({ input: process.stdin });
appServerInput?.on('line', (line) => {
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
    case 'thread/start': {
      const cwd = request.params.cwd ?? process.cwd();
      const thread = addThread(uuidV7(Date.now()), cwd, request.params.ephemeral === true);
      result = {
        thread: threadShape(thread),
        model: model.id,
        modelProvider: 'openai',
        approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
        reasoningEffort: 'medium',
        serviceTier: null,
      };
      break;
    }
    case 'thread/resume': {
      // As Codex: a thread resumes from its rollout, so one that was never prompted cannot.
      const thread = findThread(request.params.threadId);
      if (!(thread?.rollout && existsSync(thread.rollout))) {
        const message = `no rollout found for thread id ${request.params.threadId}`;
        send({ id: request.id, error: { code: -32_600, message } });
        return;
      }
      result = {
        thread: threadShape(thread),
        model: model.id,
        modelProvider: 'openai',
        approvalPolicy: 'on-request',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: 'medium',
        materialized: true,
        collaborationMode: 'default',
      };
      break;
    }
    case 'thread/read': {
      const thread = findThread(request.params.threadId);
      if (!thread) {
        const message = `thread not found: ${request.params.threadId}`;
        send({ id: request.id, error: { code: -32_600, message } });
        return;
      }
      result = {
        thread: threadShape(thread, request.params.includeTurns ? readTurns(thread) : []),
      };
      break;
    }
    case 'thread/goal/get':
      result = { goal: null };
      break;
    case 'turn/interrupt':
      interrupts.get(request.params.turnId)?.();
      break;
    case 'turn/steer': {
      const turnId = request.params.expectedTurnId;
      pendingSteers.get(turnId)?.(request.params.input);
      result = { turnId };
      break;
    }
    case 'mcpServerStatus/list':
      result = { data: [], nextCursor: null };
      break;
    case 'turn/start': {
      const turn = { id: `turn-${request.id}`, status: 'inProgress', items: [], error: null };
      const threadId = request.params.threadId;
      // As Codex: with a history (CODEX_HOME), a turn needs a thread this process started or
      // resumed, so a restart that skipped thread/resume fails here. Without one, a thread this
      // process does not know (the tests send turn/start alone) is adopted.
      const thread = codexHome
        ? threads.get(threadId)
        : (threads.get(threadId) ?? addThread(threadId, request.params.cwd ?? process.cwd()));
      if (!thread) {
        send({
          id: request.id,
          error: { code: -32_600, message: `thread not found: ${threadId}` },
        });
        return;
      }
      send({ id: request.id, result: { turn } });
      const text = promptText(request.params.input);
      // Request ids, and so turn ids, start again in each process: the rollout's carry this
      // process's nonce, so that the turns of one conversation stay distinct across restarts.
      record(thread, 'event_msg', { type: 'task_started', turn_id: `${turn.id}-${processNonce}` });
      record(thread, 'event_msg', { type: 'user_message', message: text });
      // Ephemeral title threads keep the contract reply, so only the conversation plays a scenario.
      const scenario = thread.ephemeral ? null : chooseScenario(text);
      if (scenario) {
        setTimeout(() => void playScenario(request, turn.id, thread, scenario), 5);
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
        record(thread, 'event_msg', { type: 'agent_message', message: 'Synthetic response' });
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
