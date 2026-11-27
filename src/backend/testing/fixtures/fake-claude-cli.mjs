#!/usr/bin/env node
// Synthetic Claude Code CLI for testing the released Claude ACP adapter and the Claude Agent SDK
// without inference. The adapter and the application find it through CLAUDE_CODE_EXECUTABLE.
// Self-contained: tests copy this one file into a temp dir.
//
// The exchange. The SDK starts the CLI with `--input-format stream-json --output-format
// stream-json` and talks newline-delimited JSON on stdin and stdout: `control_request` /
// `control_response` in both directions, `user` messages in, and `system`, `stream_event`,
// `assistant`, `user` (tool results, replays) and `result` messages out. The shapes are copied
// from the recording in upstream/claude/0.3.312/cli-stdio.jsonl. The command line also answers
// `--version` (health check) and `auth status --json` (health check and the adapter's identity
// probe).
//
// Choosing a scenario (see `scenarios`). As in fake-codex-app-server.mjs: a prompt containing
// `ff-scenario:<name>` or `ff-scenario:<name>:<argument>` plays that scenario; a prompt without
// the token plays FF_SANDBOX_SCENARIO (the sandbox sets `echo`); with neither, the fake replies
// `Synthetic response`. An unknown name in a prompt fails that turn, naming the valid ones; an
// unknown FF_SANDBOX_SCENARIO stops the process. A session started with a JSON schema (the
// application's disposable inference) always answers with structured output instead.
//
// Isolation. The fake refuses to start unless CLAUDE_CONFIG_DIR is set inside the OS temporary
// directory, and it writes nothing but its call log. FF_SANDBOX_CLAUDE_LOG, when set (also inside
// the temporary directory), receives one JSON line per invocation (`argv`) and one per control
// request the fake answers (`control`), so a sandbox run can show that every Claude launch reached
// the fake. No transcript is written: a `--resume` of any session fails as the CLI fails for a
// session it has no transcript of.
//
// Guesses. The recording scrubs these values, so the fake uses plausible ones:
// - `--version` prints `2.1.312 (Claude Code)` (the recorded CLI version, the CLI's format).
// - `auth status --json`: authMethod `claude.ai`, apiProvider `firstParty`, a made-up email,
//   organisation and orgId, subscriptionType `max`. The keys and `loggedIn: true` are recorded.
// - initialize: `models` lists default, opus, sonnet and haiku with the names the adapter showed
//   for them in acp.jsonl and resolved ids `claude-<family>-5-5`; effort levels
//   low/medium/high/xhigh/max (acp.jsonl). Three built-in commands (compact, init, review), one
//   agent (general-purpose), output style `default`, account values as in `auth status`.
// - system/init: `tools` (Bash, Edit, Glob, Grep, Read, Write unless `--tools` names others),
//   `permissionMode` (from `--permission-mode` or set_permission_mode), `apiKeySource` `none`,
//   no skills, plugins or MCP servers.
// - get_context_usage: zero categories and counts the recording also scrubs to 0, a 200k window.
// - get_settings: applied effort `high`; generate_session_title: the first six prompt words.
// - get_usage (plan usage, not in the recording): the shape the application's
//   provider-usage-normalizer.ts reads, with 12% and 34% used.
// - The permission request: `display_name` `Bash`, `decision_reason` `This command requires
//   approval` (the adapter shows it as "Reason: …" in acp.jsonl), an `addRules` suggestion.
// - Token counts and costs are small made-up numbers; ids are random.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

const CLI_VERSION = '2.1.312';
const scenarioToken = /\bff-scenario:([a-z][a-z-]*)(?::([\w-]+))?/;

/** True when `path` (or, for a file not made yet, its directory) is inside the OS temp dir. */
function insideTempDir(path) {
  let target = path;
  while (!existsSync(target) && dirname(target) !== target) {
    target = dirname(target);
  }
  try {
    const rel = relative(realpathSync(tmpdir()), realpathSync(target));
    return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
  } catch {
    return false;
  }
}

function refuse(message) {
  process.stderr.write(`fake Claude CLI: ${message}\n`);
  process.exit(2);
}

const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || null;
if (!(configDir && isAbsolute(configDir) && insideTempDir(configDir))) {
  refuse('CLAUDE_CONFIG_DIR must be set to a directory inside the OS temporary directory.');
}
const callLog = process.env.FF_SANDBOX_CLAUDE_LOG?.trim() || null;
if (callLog && !(isAbsolute(callLog) && insideTempDir(callLog))) {
  refuse('FF_SANDBOX_CLAUDE_LOG must be inside the OS temporary directory.');
}
function logCall(entry) {
  if (callLog) {
    appendFileSync(callLog, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
  }
}

const args = process.argv.slice(2);
logCall({ argv: args });

/**
 * Options as the SDK writes them: `--name=value`, `--name value` (a value never starts with `-`)
 * and bare `--name` flags.
 */
function parseOptions(list) {
  const options = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const match = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(list[index]);
    if (!match) {
      continue;
    }
    const next = list[index + 1];
    if (match[2] !== undefined) {
      options.set(match[1], match[2]);
    } else if (next !== undefined && !next.startsWith('-')) {
      options.set(match[1], next);
      index += 1;
    } else {
      options.set(match[1], true);
    }
  }
  return options;
}
const options = parseOptions(args);

const account = {
  email: 'sandbox@factory-factory.invalid',
  organization: 'Sandbox organisation',
  subscriptionType: 'max',
  apiProvider: 'firstParty',
};

/** The command line, answered the way the CLI answers it; null starts a stream-json session. */
function answerCommandLine() {
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    return { stream: process.stdout, text: `${CLI_VERSION} (Claude Code)\n`, code: 0 };
  }
  // The adapter may put global options such as `--settings=…` before the subcommand.
  const words = args.filter((arg) => !arg.startsWith('--settings'));
  if (words[0] === 'auth' && words[1] === 'status') {
    // A scripted stand-in with no account reports a signed-in state so that the health check and
    // the adapter's identity probe pass. It holds and reads no credential.
    const status = {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: account.apiProvider,
      analyticsDisabled: true,
      projectsDirectory: join(configDir, 'projects'),
      configDirectory: configDir,
      email: account.email,
      orgId: '00000000-0000-4000-8000-00000000f00d',
      orgName: account.organization,
      subscriptionType: account.subscriptionType,
    };
    return { stream: process.stdout, text: `${JSON.stringify(status, null, 2)}\n`, code: 0 };
  }
  if (
    options.get('input-format') === 'stream-json' &&
    options.get('output-format') === 'stream-json'
  ) {
    return null;
  }
  return {
    stream: process.stderr,
    text: `fake Claude CLI: unsupported arguments: ${args.join(' ')}\n`,
    code: 2,
  };
}

const scenarios = {
  echo: async (turn) => {
    await turn.reply(turn.text || '(The prompt had no text.)');
  },
  'permission-request': async (turn) => {
    const command = 'echo "Hello from the sandbox"';
    const allowed = await turn.bash(
      { command, description: 'Print a greeting from the sandbox' },
      'Hello from the sandbox\n'
    );
    if (turn.interrupted) {
      return;
    }
    await turn.reply(
      allowed
        ? 'You approved the command, so I ran it.'
        : 'You declined the command, so I did not run it.'
    );
  },
};
const scenarioName = process.env.FF_SANDBOX_SCENARIO;
if (scenarioName !== undefined && !Object.hasOwn(scenarios, scenarioName)) {
  refuse(
    `Unknown FF_SANDBOX_SCENARIO "${scenarioName}". Valid scenarios: ${Object.keys(scenarios).join(', ')}`
  );
}

/** A prompt's own token, else FF_SANDBOX_SCENARIO, else null for the contract reply. */
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

const models = [
  ['default', 'Default (recommended)', 'claude-opus-5-5', 'The recommended model'],
  ['opus', 'Opus 5.5', 'claude-opus-5-5', 'The most capable model'],
  ['sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5', 'The everyday model'],
  ['haiku', 'Haiku 5.5', 'claude-haiku-5-5', 'The fastest model'],
].map(([value, displayName, resolvedModel, description]) => ({
  value,
  resolvedModel,
  displayName,
  description,
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsAdaptiveThinking: true,
  supportsFastMode: true,
  supportsAutoMode: true,
  supportsThinkingOff: false,
}));
const commands = [
  ['compact', 'Clear conversation history but keep a summary in context', '<instructions>'],
  ['init', 'Initialize a CLAUDE.md file with codebase documentation', ''],
  ['review', 'Review a pull request', '<pr>'],
].map(([name, description, argumentHint]) => ({ name, description, argumentHint, builtin: true }));
const agents = [{ name: 'general-purpose', description: 'General-purpose agent' }];

/** The resolved model id for an alias, a listed value or a full id. */
function resolveModel(value) {
  const listed = models.find((model) => model.value === value);
  return listed?.resolvedModel ?? (typeof value === 'string' && value ? value : 'claude-opus-5-5');
}

const session = {
  id: (typeof options.get('session-id') === 'string' && options.get('session-id')) || randomUUID(),
  cwd: process.cwd(),
  model: resolveModel(options.get('model')),
  permissionMode:
    typeof options.get('permission-mode') === 'string' ? options.get('permission-mode') : 'default',
  replayUserMessages: options.has('replay-user-messages'),
  jsonSchema: parseJson(options.get('json-schema')),
  tools: parseTools(options.get('tools')),
  // Event name -> [{ matcher, hookCallbackIds }], from initialize.
  hooks: {},
};

function parseJson(value) {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseTools(value) {
  if (value === undefined || value === 'default') {
    return ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];
  }
  return typeof value === 'string' ? value.split(',').filter(Boolean) : [];
}

const encodedCwd = session.cwd.replace(/[^A-Za-z0-9]/g, '-');
const transcriptPath = join(configDir, 'projects', encodedCwd, `${session.id}.jsonl`);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
/** Messages the CLI sends about the session carry its id and their own uuid. */
const emit = (message) => send({ ...message, session_id: session.id, uuid: randomUUID() });

const pendingRequests = new Map();
/** A control request to the SDK (a hook, a permission); resolves with its response. */
function request(subtype, payload) {
  const requestId = randomUUID();
  send({ type: 'control_request', request_id: requestId, request: { subtype, ...payload } });
  return new Promise((resolve) => pendingRequests.set(requestId, resolve));
}

const usage = (input, output) => ({
  input_tokens: input,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: output,
  service_tier: 'standard',
});

/** A schema-shaped value: the application's disposable inference asks for one. */
function sampleFor(schema, key = 'value') {
  if (!schema || typeof schema !== 'object') {
    return null;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return sampleFor(schema.anyOf[0], key);
  }
  switch (schema.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([name, value]) => [
          name,
          sampleFor(value, name),
        ])
      );
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return schema.minimum ?? 0;
    case 'string': {
      const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      const text = schema.pattern ? `sandbox-${words.replace(/\s+/g, '-')}` : `Sandbox ${words}`;
      return text.slice(0, schema.maxLength ?? text.length);
    }
    default:
      return null;
  }
}

let currentTurn = null;

/** Streams one assistant message of `blocks` with the recorded stream_event sequence. */
async function streamMessage(turn, blocks, stopReason) {
  const messageId = `msg_fake_${randomUUID().replaceAll('-', '')}`;
  const outputTokens = 8 * blocks.length;
  const shape = (content) => ({
    model: session.model,
    id: messageId,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: null,
    stop_sequence: null,
    usage: usage(12, outputTokens),
  });
  const stream = (event) =>
    emit({ type: 'stream_event', event, parent_tool_use_id: null, api_message_id: messageId });
  stream({ type: 'message_start', message: shape([]) });
  const sent = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text') {
      stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      let text = '';
      // Three chunks at most, split at spaces, so a reply streams like the recorded one.
      const words = block.text.split(/(?<= )/);
      const size = Math.max(1, Math.ceil(words.length / 3));
      for (let start = 0; start < words.length; start += size) {
        if (turn.interrupted) {
          break;
        }
        const delta = words.slice(start, start + size).join('');
        text += delta;
        stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } });
        await new Promise((resolve) => setImmediate(resolve));
      }
      sent.push({ type: 'text', text });
    } else {
      const toolUse = { type: 'tool_use', id: block.id, name: block.name, input: {} };
      stream({ type: 'content_block_start', index, content_block: toolUse });
      const partial = JSON.stringify(block.input);
      stream({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: partial },
      });
      sent.push({ ...toolUse, input: block.input });
    }
  }
  emit({
    type: 'assistant',
    message: shape(sent),
    parent_tool_use_id: null,
    timestamp: new Date().toISOString(),
    ...(turn.interrupted ? { aborted: true } : {}),
  });
  turn.afterAssistant?.();
  for (const index of blocks.keys()) {
    stream({ type: 'content_block_stop', index });
  }
  stream({
    type: 'message_delta',
    delta: { stop_reason: turn.interrupted ? null : stopReason, stop_sequence: null },
    usage: usage(12, outputTokens),
  });
  stream({ type: 'message_stop' });
  turn.outputTokens += outputTokens;
  return sent;
}

/** Calls every hook the SDK registered for `event` (and whose matcher fits `toolName`). */
async function runHooks(event, toolName, input) {
  const responses = [];
  for (const entry of session.hooks[event] ?? []) {
    if (entry.matcher && !new RegExp(`^(?:${entry.matcher})$`).test(toolName)) {
      continue;
    }
    for (const callbackId of entry.hookCallbackIds ?? []) {
      responses.push(
        await request('hook_callback', {
          callback_id: callbackId,
          input: {
            session_id: session.id,
            transcript_path: transcriptPath,
            cwd: session.cwd,
            permission_mode: session.permissionMode,
            hook_event_name: event,
            tool_name: toolName,
            ...input,
          },
          tool_use_id: input.tool_use_id,
        })
      );
    }
  }
  return responses;
}

/** Whether the CLI asks before running Bash in this permission mode. */
const asksForBash = () => !['bypassPermissions', 'dontAsk'].includes(session.permissionMode);

function createTurn(message, text) {
  const turn = {
    text,
    userUuid: message.uuid ?? randomUUID(),
    interrupted: false,
    outputTokens: 0,
    numTurns: 0,
    replies: [],
    denials: [],
    failure: null,
    structuredOutput: undefined,
    cancel: () => undefined,
    async reply(replyText) {
      if (turn.interrupted) {
        return;
      }
      turn.numTurns += 1;
      emit({
        type: 'system',
        subtype: 'status',
        status: 'requesting',
        user_message_uuids: [turn.userUuid],
      });
      const [block] = await streamMessage(turn, [{ type: 'text', text: replyText }], 'end_turn');
      turn.replies.push(block.text);
    },
    /** One Bash call: hooks, the permission request, then its result. True when it ran. */
    async bash(input, output) {
      turn.numTurns += 1;
      const toolUseId = `toolu_fake_${randomUUID().replaceAll('-', '')}`;
      let preHooks;
      turn.afterAssistant = () => {
        preHooks = runHooks('PreToolUse', 'Bash', { tool_input: input, tool_use_id: toolUseId });
      };
      await streamMessage(
        turn,
        [{ type: 'tool_use', id: toolUseId, name: 'Bash', input }],
        'tool_use'
      );
      turn.afterAssistant = undefined;
      const decisions = (await preHooks).map(
        (response) => response?.hookSpecificOutput?.permissionDecision
      );
      let decision = decisions.includes('deny')
        ? { behavior: 'deny', message: 'A PreToolUse hook denied this command.' }
        : decisions.includes('allow') || !asksForBash()
          ? { behavior: 'allow', updatedInput: input }
          : null;
      if (!decision && !turn.interrupted) {
        emit({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' });
        const answer = request('can_use_tool', {
          tool_name: 'Bash',
          display_name: 'Bash',
          input,
          description: input.description,
          permission_suggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ],
          decision_reason: 'This command requires approval',
          decision_reason_type: 'other',
          tool_use_id: toolUseId,
        });
        decision = await Promise.race([
          answer,
          new Promise((resolve) => {
            turn.cancel = () => resolve({ behavior: 'deny', message: 'Interrupted' });
          }),
        ]);
        turn.cancel = () => undefined;
        if (!turn.interrupted) {
          emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        }
      }
      if (turn.interrupted) {
        return false;
      }
      const allowed = decision?.behavior === 'allow';
      const toolResponse = {
        stdout: output,
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      };
      if (allowed) {
        await runHooks('PostToolUse', 'Bash', {
          tool_input: decision.updatedInput ?? input,
          tool_response: toolResponse,
          tool_use_id: toolUseId,
          duration_ms: 1,
        });
      } else {
        turn.denials.push({ tool_name: 'Bash', tool_use_id: toolUseId, tool_input: input });
      }
      const content = allowed
        ? output.replace(/\n$/, '')
        : (decision?.message ?? 'The user doesn’t want to proceed with this tool use.');
      emit({
        type: 'user',
        message: {
          role: 'user',
          content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: !allowed }],
        },
        parent_tool_use_id: null,
        timestamp: new Date().toISOString(),
        ...(allowed ? { tool_use_result: toolResponse } : {}),
      });
      return allowed;
    },
    fail(errorText) {
      turn.failure = errorText;
    },
  };
  return turn;
}

function resultMessage(turn) {
  const text = turn.failure ?? turn.replies.join('\n');
  const base = {
    type: 'result',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: Math.max(1, turn.numTurns),
    session_id: session.id,
    total_cost_usd: 0,
    usage: usage(12, turn.outputTokens),
    modelUsage: {
      [session.model]: {
        inputTokens: 12,
        outputTokens: turn.outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    },
    permission_denials: turn.denials,
    user_message_uuids: [turn.userUuid],
  };
  if (turn.interrupted) {
    return {
      ...base,
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: null,
      errors: [],
    };
  }
  return {
    ...base,
    subtype: 'success',
    is_error: turn.failure !== null,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    result: text,
    ...(turn.structuredOutput === undefined ? {} : { structured_output: turn.structuredOutput }),
  };
}

/** One user message: the turn sequence of the recording, around the chosen scenario. */
async function playTurn(message) {
  const content = message.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : (content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
  const turn = createTurn(message, text);
  currentTurn = turn;
  const lifecycle = (state) =>
    emit({ type: 'command_lifecycle', command_uuid: turn.userUuid, state });
  emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  lifecycle('queued');
  lifecycle('started');
  emit(systemInit([turn.userUuid]));
  if (session.replayUserMessages) {
    send({
      ...message,
      session_id: session.id,
      uuid: turn.userUuid,
      timestamp: new Date().toISOString(),
      isReplay: true,
    });
  }
  if (session.jsonSchema) {
    turn.structuredOutput = sampleFor(session.jsonSchema);
    await turn.reply(JSON.stringify(turn.structuredOutput));
  } else {
    const scenario = chooseScenario(text);
    if (scenario) {
      turn.argument = scenario.argument;
      await scenario.play(turn);
    } else {
      await turn.reply('Synthetic response');
    }
  }
  if (turn.interrupted) {
    emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString(),
    });
  }
  emit(resultMessage(turn));
  lifecycle('completed');
  emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  currentTurn = null;
}

function systemInit(userMessageUuids) {
  return {
    type: 'system',
    subtype: 'init',
    cwd: session.cwd,
    tools: session.tools,
    mcp_servers: [],
    model: session.model,
    permissionMode: session.permissionMode,
    slash_commands: commands.map((command) => command.name),
    apiKeySource: 'none',
    claude_code_version: CLI_VERSION,
    output_style: 'default',
    agents: agents.map((agent) => agent.name),
    skills: [],
    plugins: [],
    capabilities: [],
    analytics_disabled: true,
    memory_paths: { auto: join(configDir, 'projects', encodedCwd, 'memory/') },
    original_cwd: session.cwd,
    additional_directories: [],
    fast_mode_state: 'off',
    per_turn_effort_active: true,
    user_message_uuids: userMessageUuids,
  };
}

const contextUsage = () => ({
  categories: [],
  totalTokens: 0,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'default',
  percentage: 0,
  gridRows: [],
  model: session.model,
  memoryFiles: [],
  mcpTools: [],
  mcpInstructions: [],
  agents: [],
  slashCommands: { totalCommands: commands.length, includedCommands: 0, tokens: 0 },
  skills: { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: [] },
  isAutoCompactEnabled: false,
  messageBreakdown: {
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    redirectedContextTokens: 0,
    unattributedTokens: 0,
    toolCallsByType: [],
    attachmentsByType: [],
  },
  apiUsage: null,
});

const planUsage = () => {
  const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  return {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: inDays(0.2) },
      seven_day: { utilization: 34, resets_at: inDays(3) },
    },
  };
};

/** The answer to one control request from the SDK; undefined for an unsupported one. */
function answerControl(request) {
  switch (request.subtype) {
    case 'initialize':
      session.hooks = request.hooks ?? {};
      session.jsonSchema ??= request.jsonSchema ?? null;
      return {
        commands,
        agents,
        output_style: 'default',
        available_output_styles: ['default', 'Explanatory', 'Learning'],
        user_output_styles_dir: join(configDir, 'output-styles'),
        models,
        account,
        pid: process.pid,
        claude_code_version: CLI_VERSION,
        current_permission_mode: session.permissionMode,
        hooks_applied: true,
        analytics_disabled: true,
        fast_mode_state: 'off',
        session_state: 'idle',
        capabilities: [],
      };
    case 'set_model':
      session.model = resolveModel(request.model);
      return { model: session.model };
    case 'set_permission_mode':
      session.permissionMode = request.mode ?? session.permissionMode;
      return {};
    case 'set_max_thinking_tokens':
    case 'apply_flag_settings':
    case 'set_effort':
      return {};
    case 'get_settings':
      return {
        effective: {},
        sources: [],
        applied: {
          model: session.model,
          effort: 'high',
          advisor: null,
          ultracode: false,
          ultracodeRequested: false,
          ultracodeAvailable: false,
        },
      };
    case 'get_context_usage':
      return contextUsage();
    case 'mcp_status':
      return { mcpServers: [] };
    case 'generate_session_title': {
      const words = (request.description ?? '').split(/\s+/).filter(Boolean).slice(0, 6);
      return { title: words.join(' ') || 'Sandbox conversation' };
    }
    case 'get_usage':
      return planUsage();
    case 'interrupt':
      if (currentTurn) {
        currentTurn.interrupted = true;
        currentTurn.cancel();
      }
      return {};
    default:
      return undefined;
  }
}

function startSession() {
  if (typeof options.get('resume') === 'string' || options.has('continue')) {
    // No transcript is ever written, so there is nothing to resume (see the top of this file).
    process.stderr.write(
      `No conversation found with session ID: ${options.get('resume') || '(latest)'}\n`
    );
    process.exitCode = 1;
    return;
  }
  let turns = Promise.resolve();
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    const message = JSON.parse(line);
    if (message.type === 'control_response') {
      const response = message.response ?? {};
      pendingRequests.get(response.request_id)?.(response.response ?? {});
      pendingRequests.delete(response.request_id);
      return;
    }
    if (message.type === 'control_request') {
      const subtype = message.request?.subtype;
      logCall({ control: subtype });
      const answer = answerControl(message.request ?? {});
      send({
        type: 'control_response',
        response:
          answer === undefined
            ? {
                subtype: 'error',
                request_id: message.request_id,
                error: `The fake Claude CLI does not support ${subtype}.`,
              }
            : { subtype: 'success', request_id: message.request_id, response: answer },
      });
      return;
    }
    if (message.type === 'user') {
      turns = turns.then(() => playTurn(message));
    }
  });
  input.on('close', () => {
    // Every pending turn finishes, then the process ends: as the CLI, which exits at end of input.
    void turns.then(() => {
      process.exitCode ??= 0;
    });
  });
}

const commandLineAnswer = answerCommandLine();
if (commandLineAnswer) {
  // exitCode, not exit(): a pipe write may still be pending on macOS.
  commandLineAnswer.stream.write(commandLineAnswer.text);
  process.exitCode = commandLineAnswer.code;
} else {
  startSession();
}
