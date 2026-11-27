// Allowlist scrubber for upstream recordings (see scripts/record-upstream.mjs).
//
// A recording is published in a public repository, so nothing is kept because
// it "looks safe". Each stream has a policy that names what may survive:
//
// - `keep`: keys whose short strings are structural (types, roles, methods,
//   tool names, ids of modes and options). A kept value that still looks
//   private after path rewriting becomes "<string>".
// - `opaque`: record types (configuration, account and environment snapshots,
//   listings) that keep only their shape and discriminators.
// - `text`: keys whose strings are conversation text: the recorder's prompts,
//   the model's replies, and tool input and output in the throwaway repository.
//   They are kept only in the record types `allowsText` accepts; context the
//   tools inject on their own (system prompts, account and environment
//   attachments, listings) is never conversation text. Known roots are
//   rewritten (`/workspace` for the repository), any other home directory
//   becomes `/user-home`, and text that still looks private becomes
//   "<redacted>".
// - `numbers`: keys whose numbers a parser needs (JSON-RPC ids, protocol
//   versions, token counts, exit codes). Every other number becomes 0.
//
// Regardless of key, UUIDs map to fixed fake UUIDs, prefixed ids (`toolu_…`,
// `msg_…`, `exec-<uuid>`) to fixed fake ids with the same prefix (and length,
// up to 24 characters), and ISO timestamps to a fixed sequence, so references
// between records still line up. Object keys that are ids are faked too.
// Absolute paths under a known root are rewritten. Every other string becomes
// "<string>". Booleans and null are kept.

export const PLACEHOLDER_STRING = '<string>';
export const PLACEHOLDER_NUMBER = 0;
export const HOME_PLACEHOLDER = '/user-home';
/** Text that still looked private after rewriting; the recorder reports how many. */
export const REDACTED = '<redacted>';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// A UUID behind a short prefix, as in `exec-<uuid>` or `msg_<uuid>`.
const PREFIXED_UUID =
  /^([A-Za-z][A-Za-z0-9]{0,15}[-_])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// An id body has a digit; `input_transformations` is a key, not an id.
const PREFIXED_ID = /^([a-z]{2,12}_)((?=[A-Za-z]*\d)[A-Za-z0-9]{12,})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const HOME_PATH = /\/(?:Users|home)\/[^/\s"'`<>]+/;
const HOME_PATH_GLOBAL = new RegExp(HOME_PATH.source, 'g');
const EMAIL = /[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const TOKEN_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bBearer\s/,
  /eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/,
  /[A-Za-z0-9+/]{40,}/,
  /[0-9a-f]{32,}/i,
];
const FAKE_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
const MAX_KEPT_LENGTH = 200;
const MAX_FAKE_ID_BODY = 24;
const NO_TEXT = new Set();
// Records a policy marks opaque (configuration, account and environment
// snapshots, listings of commands, tools, plugins and skills) keep their shape
// and these discriminators only.
const OPAQUE_RULES = {
  keep: new Set(['type', 'subtype', 'role', 'kind', 'status', 'operation', 'request_id']),
  text: NO_TEXT,
  numbers: NO_TEXT,
};

// Keys every stream may keep as structural strings.
const COMMON_KEEP = [
  'type',
  'subtype',
  'role',
  'method',
  'jsonrpc',
  'kind',
  'status',
  'name',
  'tool_name',
  'toolName',
  'stop_reason',
  'stopReason',
  'outcome',
  'optionId',
  'modeId',
  'currentModeId',
  'model',
  'modelId',
  'permissionMode',
];
const TOKEN_COUNTS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'ephemeral_5m_input_tokens',
  'ephemeral_1h_input_tokens',
];

const ACP_TEXT_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
]);
const CODEX_TEXT_ITEMS = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'local_shell_call',
  'user_message',
  'agent_message',
  'agent_reasoning',
  'exec_command_begin',
  'exec_command_end',
  'exec_approval_request',
  'item_completed',
  'item_started',
  'task_complete',
]);

/** One policy per recorded stream. Anything not listed is scrubbed. */
export const POLICIES = {
  // ACP JSON-RPC between the client and the adapter, both directions.
  acp: {
    keep: new Set([
      ...COMMON_KEEP,
      'sessionUpdate',
      'id',
      'category',
      'currentValue',
      'value',
      'currency',
      'title',
      'mimeType',
      'version',
      'capabilities',
      'actions',
      'phase',
      'currentModelId',
      'configId',
      'resetValue',
      'controlMethod',
      'presentation',
      'commandTitle',
      'activeFlags',
      '_claude/model',
    ]),
    text: new Set([
      'text',
      'command',
      'description',
      'content',
      'stdout',
      'stderr',
      'output',
      'data',
      'path',
    ]),
    numbers: new Set([
      'id',
      'version',
      'protocolVersion',
      'code',
      'line',
      'exitCode',
      'exit_code',
      'used',
      'size',
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cachedReadTokens',
      'cachedWriteTokens',
      'thoughtTokens',
    ]),
    // Prompts, conversation updates and permission requests; not listings or
    // configuration.
    allowsText: (message) =>
      message.method === 'session/prompt' ||
      message.method === 'session/request_permission' ||
      (message.method === 'session/update' &&
        ACP_TEXT_UPDATES.has(message.params?.update?.sessionUpdate)),
  },
  // stream-json between the Claude Agent SDK and the Claude Code CLI.
  claudeStdio: {
    keep: new Set([
      ...COMMON_KEEP,
      'request_id',
      'behavior',
      'claude_code_version',
      'apiKeySource',
      'authMethod',
      'apiProvider',
      'output_style',
      'tools',
      'mode',
      'state',
      'event',
      'id',
      'rateLimitType',
      'stop_sequence',
      'service_tier',
      'destination',
      'decisionReason',
      'decision_reason_type',
      'decisionClassification',
      'hook_event_name',
      'permission_mode',
      'terminal_reason',
    ]),
    text: new Set([
      'text',
      'thinking',
      'partial_json',
      'content',
      'command',
      'description',
      'result',
      'stdout',
      'stderr',
      'file_path',
    ]),
    numbers: new Set([
      ...TOKEN_COUNTS,
      'index',
      'num_turns',
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
      'contextWindow',
      'maxOutputTokens',
    ]),
    // Conversation messages and tool permission requests; not the initialize
    // exchange, settings, status or account records.
    allowsText: (message) =>
      ['user', 'assistant', 'stream_event', 'result'].includes(message.type) ||
      (message.type === 'control_request' && message.request?.subtype === 'can_use_tool') ||
      (message.type === 'control_response' && message.response?.response?.behavior !== undefined),
    // `auth status` output (no type), the init record, the initialize request
    // and the CLI's control responses (account, commands, models, plugins,
    // context usage). A permission decision stays readable.
    opaque: (message) =>
      message.type === undefined ||
      (message.type === 'system' && message.subtype === 'init') ||
      (message.type === 'control_request' && message.request?.subtype === 'initialize') ||
      (message.type === 'control_response' && message.response?.response?.behavior === undefined),
  },
  // The Claude Code session history file (~/.claude/projects/<cwd>/<id>.jsonl).
  claudeHistory: {
    keep: new Set([
      ...COMMON_KEEP,
      'id',
      'version',
      'userType',
      'entrypoint',
      'gitBranch',
      'operation',
      'level',
      'stop_sequence',
      'service_tier',
      'origin',
      'promptSource',
      'turnOrigin',
      'renderedRole',
      'querySource',
      'effort',
      'perTurnEffort',
      'requestedModel',
      'advisorModel',
      'decision',
      'source',
      'grantScope',
      'reasonCode',
    ]),
    text: new Set([
      'text',
      'thinking',
      'content',
      'command',
      'description',
      'stdout',
      'stderr',
      'file_path',
      'lastPrompt',
      'aiTitle',
    ]),
    numbers: new Set([...TOKEN_COUNTS, 'apiBlockIndex']),
    // User and assistant messages, the last prompt and the generated title;
    // not attachments, API request snapshots or cost records.
    allowsText: (record) => ['user', 'assistant', 'last-prompt', 'ai-title'].includes(record.type),
    // Attachments (environment, account, listings, prompt snapshots), API
    // request snapshots, tool usage and cost records.
    opaque: (record) =>
      [
        'attachment',
        'api-request-shape',
        'api-request-blob',
        'api-request',
        'tools-used',
        'atis-latch',
        'cost-state',
      ].includes(record.type),
  },
  // The Codex rollout file (CODEX_HOME/sessions/…/rollout-*.jsonl).
  codexRollout: {
    keep: new Set([
      ...COMMON_KEEP,
      'id',
      'cli_version',
      'originator',
      'source',
      'approval_policy',
      'sandbox_mode',
      'mode',
      'effort',
      'summary',
      'phase',
      'model_provider',
      'reason',
      'call_id',
    ]),
    text: new Set([
      'text',
      'message',
      'command',
      'cmd',
      'arguments',
      'input',
      'output',
      'aggregated_output',
      'stdout',
      'stderr',
      'formatted_output',
      'cwd',
      'workdir',
      'justification',
      'last_agent_message',
    ]),
    numbers: new Set([
      'exit_code',
      'ordinal',
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
      'total_tokens',
      'model_context_window',
    ]),
    // Conversation items between the user and the model, tool calls and their
    // output; not session metadata, developer instructions, tool listings,
    // world state, settings or usage records. User messages Codex writes on its
    // own (environment context) are kept: they hold only the rewritten cwd,
    // the shell and the date.
    allowsText: (record) =>
      (record.type === 'response_item' || record.type === 'event_msg') &&
      CODEX_TEXT_ITEMS.has(record.payload?.type) &&
      record.payload?.role !== 'developer' &&
      record.payload?.role !== 'system',
    // World state (instructions, skills, environment) and tool listings.
    opaque: (record) =>
      record.type === 'world_state' ||
      (record.type === 'response_item' && record.payload?.type === 'additional_tools'),
  },
  // Codex app-server requests and responses read outside a turn.
  codexAppServer: {
    keep: new Set([
      ...COMMON_KEEP,
      'id',
      'displayName',
      'reasoningEffort',
      'defaultReasoningEffort',
      'inputModalities',
      'limitId',
      'limitName',
    ]),
    text: NO_TEXT,
    numbers: new Set(['id', 'windowDurationMins', 'limit']),
    allowsText: () => false,
  },
};

/**
 * Per-recording state: the path roots to rewrite and the fakes already handed
 * out, so one original value always maps to the same placeholder. `roots` maps
 * an absolute path to its placeholder, for example the throwaway repository to
 * `/workspace`.
 */
export function createScrubContext({ roots = {} } = {}) {
  const pairs = [];
  for (const [from, to] of Object.entries(roots)) {
    if (from.length < 2) {
      continue;
    }
    pairs.push([from, to]);
    // Claude names its project directory after the cwd with every
    // non-alphanumeric character replaced by '-'.
    pairs.push([from.replace(/[^A-Za-z0-9]/g, '-'), to.replace(/[^A-Za-z0-9]/g, '-')]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return {
    roots: pairs,
    uuids: new Map(),
    ids: new Map(),
    timestamps: new Map(),
    redactions: 0,
  };
}

function fakeUuid(context, original) {
  const key = original.toLowerCase();
  let fake = context.uuids.get(key);
  if (!fake) {
    const n = context.uuids.size + 1;
    fake = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    context.uuids.set(key, fake);
  }
  return fake;
}

function fakeId(context, prefix, body) {
  const original = prefix + body;
  let fake = context.ids.get(original);
  if (!fake) {
    const n = context.ids.size + 1;
    // At most 24 characters, so a fake never looks like a token to the leak test.
    fake = prefix + `Fake${n}`.padStart(Math.min(body.length, MAX_FAKE_ID_BODY), '0');
    context.ids.set(original, fake);
  }
  return fake;
}

function fakeTimestamp(context, original) {
  let fake = context.timestamps.get(original);
  if (!fake) {
    fake = new Date(FAKE_EPOCH + context.timestamps.size * 1000).toISOString();
    context.timestamps.set(original, fake);
  }
  return fake;
}

/** Rewrites known roots, then any other home directory, then embedded UUIDs. */
export function rewritePaths(value, context) {
  let result = value;
  for (const [from, to] of context.roots) {
    result = result.split(from).join(to);
  }
  return result
    .replace(HOME_PATH_GLOBAL, HOME_PLACEHOLDER)
    .replace(UUID_GLOBAL, (uuid) => fakeUuid(context, uuid));
}

/** True when a string still carries something that must never be published. */
export function looksPrivate(value) {
  return (
    HOME_PATH.test(value) ||
    EMAIL.test(value) ||
    TOKEN_SHAPES.some((pattern) => pattern.test(value))
  );
}

function isRootedPath(value, context) {
  return value.startsWith('/') && context.roots.some(([from]) => value.startsWith(from));
}

/** The fixed fake for an id-shaped string, or null when the string is not an id. */
function fakeIdentifier(value, context) {
  if (UUID.test(value)) {
    return fakeUuid(context, value);
  }
  const prefixedUuid = PREFIXED_UUID.exec(value);
  if (prefixedUuid) {
    return prefixedUuid[1] + fakeUuid(context, prefixedUuid[2]);
  }
  const prefixed = PREFIXED_ID.exec(value);
  return prefixed ? fakeId(context, prefixed[1], prefixed[2]) : null;
}

function scrubString(value, key, rules, context) {
  const fake = fakeIdentifier(value, context);
  if (fake !== null) {
    return fake;
  }
  if (ISO_TIMESTAMP.test(value)) {
    return fakeTimestamp(context, value);
  }
  if (rules.keep.has(key)) {
    const kept = rewritePaths(value, context);
    return kept.length <= MAX_KEPT_LENGTH && !looksPrivate(kept) ? kept : PLACEHOLDER_STRING;
  }
  if (rules.text.has(key)) {
    const text = rewritePaths(value, context);
    if (looksPrivate(text)) {
      context.redactions += 1;
      return REDACTED;
    }
    return text;
  }
  if (isRootedPath(value, context)) {
    const path = rewritePaths(value, context);
    return looksPrivate(path) ? PLACEHOLDER_STRING : path;
  }
  return PLACEHOLDER_STRING;
}

// Object keys can be ids too (a map from tool use id to input, for example).
function scrubKey(key, context) {
  const fake = fakeIdentifier(key, context);
  if (fake !== null) {
    return fake;
  }
  const rewritten = rewritePaths(key, context);
  return looksPrivate(rewritten) ? PLACEHOLDER_STRING : rewritten;
}

function scrubNode(value, rules, context, key) {
  if (typeof value === 'string') {
    return scrubString(value, key, rules, context);
  }
  if (typeof value === 'number') {
    return rules.numbers.has(key) ? value : PLACEHOLDER_NUMBER;
  }
  if (typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubNode(item, rules, context, key));
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [childKey, child] of Object.entries(value)) {
      result[scrubKey(childKey, context)] = scrubNode(child, rules, context, childKey);
    }
    return result;
  }
  return PLACEHOLDER_STRING;
}

/** Returns a copy of one recorded message or history line that keeps only what `policy` allows. */
export function scrubRecord(record, policy, context) {
  const isObject = record !== null && typeof record === 'object' && !Array.isArray(record);
  if (isObject && policy.opaque?.(record)) {
    return scrubNode(record, OPAQUE_RULES, context, '');
  }
  const allowsText = isObject && policy.allowsText(record);
  return scrubNode(record, allowsText ? policy : { ...policy, text: NO_TEXT }, context, '');
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// The adapter also runs `claude auth status --json` through the stdio wrapper.
// Its pretty-printed output spans several lines and can interleave with the
// session's stream-json, so consecutive non-JSON lines are joined first.
function joinMultilineOutput(records) {
  const joined = [];
  for (const record of records) {
    const previous = joined.at(-1);
    if (record.dir !== 'argv' && !parseJson(record.line).ok) {
      if (previous?.multiline && previous.dir === record.dir) {
        previous.line += `\n${record.line}`;
      } else {
        joined.push({ ...record, multiline: true });
      }
    } else {
      joined.push(record);
    }
  }
  return joined;
}

/**
 * CLI flags and plain words (subcommands, formats) are structural; any other
 * argument may be a path, an id or JSON configuration. A flag's `=value` goes.
 */
export function scrubArgument(arg) {
  if (arg.startsWith('--')) {
    return arg.split('=')[0];
  }
  return /^[a-z][a-z-]*$/.test(arg) ? arg : PLACEHOLDER_STRING;
}

/**
 * Scrubs captured `{ dir, line }` records (and `{ dir: 'argv', args }`) into
 * `{ dir, message }` records. A line that is not JSON becomes "<string>".
 */
export function scrubCapturedLines(records, policy, context) {
  return joinMultilineOutput(records).map((record) => {
    if (record.dir === 'argv') {
      return { dir: 'argv', args: record.args.map(scrubArgument) };
    }
    const parsed = parseJson(record.line);
    return {
      dir: record.dir,
      message: parsed.ok ? scrubRecord(parsed.value, policy, context) : PLACEHOLDER_STRING,
    };
  });
}
