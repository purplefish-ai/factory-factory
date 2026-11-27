// What may survive in each recorded stream, by record kind and key path.
//
// A record's kind comes from its discriminators (an ACP method, a response's
// request method, a stream-json type and subtype, a history record type). A
// kind that is not listed here is opaque: it keeps its shape and discriminator
// values only. Within a listed kind, a value survives only at a listed path:
//
// - `keep`: short structural strings (types, names of modes, options, tools).
//   An absolute path survives only under an approved root.
// - `ids`: random identifiers (SDK request ids); each becomes a stable fake, the
//   same one wherever it appears.
// - `text`: conversation text (prompts, replies, tool input and output in the
//   throwaway repository). Text that parses as JSON is scrubbed again, with
//   its keys under `<path>>`.
// - `numbers`: numbers a parser needs (token counts, exit codes, versions).
// - `maps`: objects whose keys are data rather than field names (model usage
//   keyed by model). Their keys survive when they look like plain names; their
//   children are matched as `<path>.*`.
// - `words`: `{ paths, allowed }` entries; a string at one of `paths` survives
//   only when it is one of the `allowed` words (an enum), else "<string>".
//
// Paths join object keys with `.` and skip array levels; `*` matches one key.
// Each stream's `common` rules apply to every kind of that stream, opaque ones
// included; otherwise an opaque record keeps only its top-level discriminators.
// A kind whose nested discriminators a parser needs (a role, a block type) is
// therefore listed. ./fidelity.test.ts scrubs the committed recordings again
// and fails when a value they kept, or one a parser reads, would be lost.

function rules({ keep = [], ids = [], text = [], numbers = [], maps = [], words = [] } = {}) {
  return { keep, ids, text, numbers, maps, words };
}

const OPPOSITE = {
  'client->agent': 'agent->client',
  'agent->client': 'client->agent',
  'client->server': 'server->client',
  'server->client': 'client->server',
};

// JSON-RPC streams: a request is its method; a response is the method of the
// request it answers, looked up by id in the other direction.
function jsonRpcKind(message, { dir, requests }) {
  if (typeof message.method === 'string') {
    if (message.id !== undefined) {
      requests.set(`${dir}#${message.id}`, message.method);
    }
    return message.method === 'session/update'
      ? `session/update:${message.params?.update?.sessionUpdate}`
      : message.method;
  }
  return `response:${requests.get(`${OPPOSITE[dir]}#${message.id}`) ?? 'unknown'}`;
}

const TOKENS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cache_creation.ephemeral_5m_input_tokens',
  'cache_creation.ephemeral_1h_input_tokens',
];
const under = (prefix, names) => names.map((name) => `${prefix}.${name}`);
// Each JSON Schema `type` in a tool's input schema, through nested properties
// and array items, down to SCHEMA_DEPTH keys below the schema (the recorded
// tools nest eight). Only the JSON Schema type words survive: a `default`,
// `const` or `examples` object in a user's MCP tool schema can carry its own
// `type` key with free text. Paths are patterns, which cannot recurse, so a
// deeper `type` becomes "<string>".
const SCHEMA_DEPTH = 16;
const JSON_SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
const schemaTypes = (root) => ({
  paths: Array.from(
    { length: SCHEMA_DEPTH + 1 },
    (_, depth) => `${root}${'.*'.repeat(depth)}.type`
  ),
  allowed: JSON_SCHEMA_TYPES,
});
// How the CLI asked the API to show thinking (`display` in the SDK's thinking
// configuration, `thinkingDisplay` in history).
const thinkingDisplay = (paths) => ({ paths, allowed: ['summarized', 'omitted', 'highlights'] });
const ACP_USAGE = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedReadTokens',
  'cachedWriteTokens',
  'thoughtTokens',
];
const ACP_QUOTA = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cachedWriteTokens',
  'cacheWriteInputTokens',
  'reasoningOutputTokens',
];
const AIR_VERSION = '_meta.jetbrains.air.version';

function configOptions(prefix) {
  return {
    keep: [
      ...under(prefix, ['category', 'currentValue', 'id', 'name', 'type']),
      ...under(`${prefix}.options`, ['name', 'value', '_meta.jetbrains.air.kind']),
    ],
    numbers: [`${prefix}.options.${AIR_VERSION}`],
  };
}

const ACP_CHUNK = rules({
  keep: ['params.update.content.type', 'params.update._meta.jetbrains.air.phase'],
  text: ['params.update.content.text'],
  numbers: [`params.update.${AIR_VERSION}`],
});

const acp = {
  common: rules({ keep: ['jsonrpc', 'method', 'params.update.sessionUpdate'], numbers: ['id'] }),
  kindOf: jsonRpcKind,
  kinds: {
    initialize: rules({
      keep: [
        'params.clientCapabilities._meta.jetbrains.air.capabilities',
        ...under('params.clientInfo', ['name', 'title', 'version']),
      ],
      numbers: ['params.protocolVersion', `params.clientCapabilities.${AIR_VERSION}`],
    }),
    'response:initialize': rules({
      keep: [
        'result._meta.jetbrains.air.capabilities',
        ...under('result._meta.jetbrains.air.goal', ['actions', 'controlMethod']),
        ...under('result.agentInfo', ['name', 'title', 'version']),
        ...under('result.authMethods', ['id', 'name']),
      ],
      numbers: [
        'result.protocolVersion',
        `result.${AIR_VERSION}`,
        'result._meta.jetbrains.air.goal.version',
      ],
    }),
    'session/new': rules(),
    'response:session/new': rules({
      keep: [
        ...configOptions('result.configOptions').keep,
        ...under('result.models', [
          'currentModelId',
          'availableModels.modelId',
          'availableModels.name',
        ]),
        ...under('result.modes', [
          'currentModeId',
          'availableModes.id',
          'availableModes.name',
          'availableModes._meta.jetbrains.air.kind',
        ]),
      ],
      numbers: [
        ...configOptions('result.configOptions').numbers,
        `result.modes.availableModes.${AIR_VERSION}`,
      ],
    }),
    'session/set_mode': rules({ keep: ['params.modeId'] }),
    'response:session/set_mode': rules(),
    'session/set_config_option': rules({ keep: ['params.configId', 'params.value'] }),
    'response:session/set_config_option': rules(configOptions('result.configOptions')),
    '_auth/status_update': rules({ keep: ['params.authStatus.kind'] }),
    'session/prompt': rules({ keep: ['params.prompt.type'], text: ['params.prompt.text'] }),
    'response:session/prompt': rules({
      keep: ['result.stopReason', 'result._meta.quota.model_usage.model'],
      numbers: [
        ...under('result.usage', ACP_USAGE),
        ...under('result._meta.quota.token_count', ACP_QUOTA),
        ...under('result._meta.quota.model_usage.token_count', ACP_QUOTA),
      ],
    }),
    'session/cancel': rules(),
    'session/request_permission': rules({
      keep: [
        'params._meta.jetbrains.air.permission.title',
        ...under('params.options', ['kind', 'name', 'optionId']),
        'params.toolCall.title',
      ],
      text: [
        'params._meta.jetbrains.air.permission.description',
        ...under('params.toolCall.rawInput', ['command', 'description']),
      ],
      numbers: [`params.${AIR_VERSION}`, 'params._meta.jetbrains.air.permission.version'],
    }),
    'response:session/request_permission': rules({
      keep: ['result.outcome.optionId', 'result.outcome.outcome'],
    }),
    'session/update:agent_message_chunk': ACP_CHUNK,
    'session/update:agent_thought_chunk': ACP_CHUNK,
    'session/update:user_message_chunk': ACP_CHUNK,
    'session/update:available_commands_update': rules({
      keep: [
        'params.update.availableCommands.name',
        'params.update.availableCommands._meta.jetbrains.air.kind',
        'params.update.availableCommands._meta.jetbrains.air.skillPath',
        ...under('params.update.availableCommands._meta.jetbrains.air.commandAction', [
          'configId',
          'kind',
          'presentation',
          'resetValue',
          'value',
        ]),
      ],
      numbers: [`params.update.availableCommands.${AIR_VERSION}`],
    }),
    'session/update:config_option_update': rules(configOptions('params.update.configOptions')),
    'session/update:current_mode_update': rules({ keep: ['params.update.currentModeId'] }),
    'session/update:session_info_update': rules({
      keep: [
        'params.update.title',
        ...under('params.update._meta.codex.threadStatus', ['type', 'activeFlags']),
      ],
    }),
    'session/update:usage_update': rules({
      keep: [
        'params.update._meta._claude/model',
        'params.update._meta._claude/origin.kind',
        'params.update._meta._claude/rateLimit.status',
        'params.update._meta._claude/rateLimit.unifiedWindows.*.status',
        'params.update.cost.currency',
      ],
      numbers: ['params.update.size', 'params.update.used'],
      maps: ['params.update._meta._claude/rateLimit.unifiedWindows'],
    }),
    'session/update:plan': rules({
      keep: ['params.update.entries.status', 'params.update.entries.priority'],
      text: ['params.update.entries.content'],
    }),
    'session/update:tool_call': rules({
      keep: [
        'params.update._meta.claudeCode.toolName',
        ...under('params.update', ['kind', 'name', 'status', 'title', 'content.type']),
      ],
      text: [
        ...under('params.update.rawInput', ['command', 'description']),
        'params.update.content.content.text',
      ],
    }),
    'session/update:tool_call_update': rules({
      keep: [
        'params.update._meta.jetbrains.air.commandTitle',
        ...under('params.update', ['kind', 'name', 'status', 'title', 'content.type']),
      ],
      text: [
        'params.update._meta.terminal_output_delta.data',
        ...under('params.update.rawInput', ['command', 'description']),
        'params.update.content.content.text',
      ],
      numbers: [`params.update.${AIR_VERSION}`, 'params.update._meta.terminal_exit.exit_code'],
    }),
  },
};

const STDIO_USAGE = [
  ...TOKENS,
  ...under('iterations', TOKENS),
  'output_tokens_details.thinking_tokens',
];
const MODEL_USAGE = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'contextWindow',
  'maxOutputTokens',
];
const MESSAGE_KEEP = [
  ...under('message', ['model', 'role', 'type', 'stop_reason']),
  ...under('message.content', ['type', 'name', 'caller.type']),
  'message.usage.service_tier',
  'message.usage.iterations.type',
  'message.diagnostics.cache_miss_reason.type',
];
const MESSAGE_TEXT = [
  ...under('message.content', ['text', 'thinking', 'input.command', 'input.description']),
];

const claudeStdio = {
  common: rules({
    keep: ['type', 'subtype', 'request.subtype', 'response.subtype', 'event.type'],
    // Request ids are random strings the SDK makes; they pair a response with its request.
    ids: ['request_id', 'response.request_id'],
  }),
  kindOf(message, { requests }) {
    if (message.type === undefined) {
      return 'auth-status';
    }
    if (message.type === 'system' || message.type === 'stream_event') {
      return `${message.type}:${message.type === 'system' ? message.subtype : message.event?.type}`;
    }
    if (message.type === 'control_request') {
      requests.set(`stdio#${message.request_id}`, message.request?.subtype);
      return `control_request:${message.request?.subtype}`;
    }
    if (message.type === 'control_response') {
      const subtype = requests.get(`stdio#${message.response?.request_id}`);
      return `control_response:${subtype ?? 'unknown'}`;
    }
    return message.type;
  },
  kinds: {
    'control_request:set_model': rules({ keep: ['request.model'] }),
    'control_response:initialize': rules({ keep: ['response.response.feedback_mode.kind'] }),
    'control_response:get_context_usage': rules({
      keep: ['response.response.categories.kind'],
    }),
    'control_response:set_model': rules({
      keep: ['response.response.model'],
    }),
    'control_request:get_settings': rules(),
    'control_request:get_context_usage': rules(),
    'control_request:generate_session_title': rules(),
    'control_request:interrupt': rules(),
    'control_response:interrupt': rules(),
    'control_request:hook_callback': rules({
      keep: under('request.input', ['hook_event_name', 'permission_mode', 'tool_name']),
    }),
    'control_response:hook_callback': rules(),
    'control_request:can_use_tool': rules({
      keep: [
        ...under('request', ['tool_name', 'decision_reason_type']),
        ...under('request.permission_suggestions', [
          'type',
          'behavior',
          'destination',
          'rules.toolName',
        ]),
      ],
      text: ['request.description', ...under('request.input', ['command', 'description'])],
    }),
    'control_response:can_use_tool': rules({
      keep: under('response.response', ['behavior', 'decisionClassification']),
      text: under('response.response.updatedInput', ['command', 'description']),
    }),
    'system:session_state_changed': rules({ keep: ['state'] }),
    'system:status': rules({ keep: ['status'] }),
    command_lifecycle: rules({ keep: ['state'] }),
    user: rules({
      keep: ['message.role', 'message.content.type', 'origin.kind'],
      text: [
        'message.content',
        'message.content.text',
        'message.content.content',
        'message.content.content.text',
        ...under('tool_use_result', ['stdout', 'stderr']),
      ],
    }),
    assistant: rules({
      keep: MESSAGE_KEEP,
      text: [...MESSAGE_TEXT, ...under('wire_tool_inputs.*', ['command', 'description'])],
      numbers: under('message.usage', STDIO_USAGE),
      maps: ['wire_tool_inputs'],
    }),
    'stream_event:message_start': rules({
      keep: ['event.type', ...MESSAGE_KEEP.map((path) => `event.${path}`)],
      numbers: under('event.message.usage', STDIO_USAGE),
    }),
    'stream_event:content_block_start': rules({
      keep: ['event.type', ...under('event.content_block', ['type', 'name', 'caller.type'])],
      text: under('event.content_block', ['text', 'thinking']),
      numbers: ['event.index'],
    }),
    'stream_event:content_block_delta': rules({
      keep: ['event.type', 'event.delta.type'],
      text: [
        ...under('event.delta', ['text', 'thinking', 'partial_json']),
        'event.delta.partial_json>command',
        'event.delta.partial_json>description',
      ],
      numbers: ['event.index'],
    }),
    'stream_event:content_block_stop': rules({ keep: ['event.type'], numbers: ['event.index'] }),
    'stream_event:message_delta': rules({
      keep: ['event.type', 'event.delta.stop_reason', 'event.usage.iterations.type'],
      numbers: under('event.usage', STDIO_USAGE),
    }),
    'stream_event:message_stop': rules({ keep: ['event.type'] }),
    rate_limit_event: rules({
      keep: [
        ...under('rate_limit_info', ['status', 'rateLimitType']),
        'rate_limit_info.unifiedWindows.*.status',
      ],
      maps: ['rate_limit_info.unifiedWindows'],
    }),
    result: rules({
      keep: [
        'stop_reason',
        'terminal_reason',
        'origin.kind',
        'usage.service_tier',
        'usage.iterations.type',
      ],
      text: ['result'],
      numbers: [
        'num_turns',
        ...under('usage', STDIO_USAGE),
        ...under('modelUsage.*', MODEL_USAGE),
        ...under('model_usage_since_last_result.*', MODEL_USAGE),
      ],
      maps: ['modelUsage', 'model_usage_since_last_result'],
    }),
  },
};

const HISTORY_ENVELOPE = ['userType', 'entrypoint', 'gitBranch', 'version'];

const claudeHistory = {
  common: rules({ keep: ['type', 'attachment.type'] }),
  kindOf: (record) =>
    record.type === 'attachment' ? `attachment:${record.attachment?.type}` : record.type,
  kinds: {
    // Cost totals stay zero; the model names keep the shape of the map.
    'cost-state': rules({ maps: ['modelUsage'] }),
    'queue-operation': rules({ keep: ['operation'] }),
    'last-prompt': rules({ text: ['lastPrompt'] }),
    'ai-title': rules({ keep: ['aiTitle'] }),
    // What the CLI sent the API: roles, block, cache and tool schema types, no text.
    'api-request': rules({
      keep: [
        'cacheControl.value.type',
        'params.thinking.type',
        'params.context_management.edits.type',
      ],
      words: [thinkingDisplay(['params.thinking.display'])],
    }),
    'api-request-blob': rules({ keep: ['message.role', 'message.content.type'] }),
    'api-request-shape': rules({
      keep: ['shape.system.type', 'shape.tools.type'],
      words: [schemaTypes('shape.tools.input_schema')],
    }),
    'attachment:prompt_snapshot': rules({
      words: [schemaTypes('attachment.tools.schema.input_schema')],
    }),
    user: rules({
      keep: [
        ...HISTORY_ENVELOPE,
        'permissionMode',
        'promptSource',
        'turnOrigin',
        'origin.kind',
        'message.role',
        'message.content.type',
        ...under('permissionDecision', ['decision', 'grantScope', 'reasonCode', 'source']),
      ],
      text: [
        'message.content',
        'message.content.text',
        'message.content.content',
        'message.content.content.text',
        ...under('toolUseResult', ['stdout', 'stderr']),
      ],
    }),
    assistant: rules({
      keep: [
        ...HISTORY_ENVELOPE,
        'advisorModel',
        'requestedModel',
        'effort',
        'perTurnEffort',
        ...MESSAGE_KEEP,
      ],
      text: [...MESSAGE_TEXT, ...under('wireToolInputs.*', ['command', 'description'])],
      numbers: ['apiBlockIndex', ...under('message.usage', STDIO_USAGE)],
      maps: ['wireToolInputs'],
      words: [thinkingDisplay(['thinkingDisplay'])],
    }),
  },
};

const ROLLOUT_USAGE = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];
const PERMISSION_PROFILE = [
  'type',
  'file_system.type',
  'file_system.entries.path.type',
  'file_system.entries.path.value.kind',
];
const THREAD_SETTINGS = [
  'approval_policy',
  'model',
  'collaboration_mode.mode',
  'collaboration_mode.settings.model',
  ...under('permission_profile', PERMISSION_PROFILE),
];
const ITEM_KEEP = ['type', 'phase', 'source', 'status', 'content.type', 'parsed_cmd.type'];
const ITEM_TEXT = ['content.text', 'aggregated_output', 'command', 'parsed_cmd.cmd', 'cwd'];
const MESSAGE_METADATA = 'payload.internal_chat_message_metadata_passthrough';
// A message's structure: the history loader reads its role, block types and
// content item kinds (`user.text`) to tell typed prompts from injected context.
const MESSAGE_STRUCTURE = [
  ...under('payload', ['role', 'phase', 'status', 'content.type']),
  ...under(MESSAGE_METADATA, ['content_item_kinds', 'content_item_metadata.provenance.type']),
  'metadata.retained_source.id.role',
  'metadata.mcp_attribution.status',
];
const MESSAGE_ITEM = rules({ keep: MESSAGE_STRUCTURE, text: ['payload.content.text'] });

const codexRollout = {
  common: rules({ keep: ['type', 'payload.type'], numbers: ['ordinal'] }),
  kindOf: (record) =>
    [record.type, record.payload?.type, record.payload?.type === 'message' && record.payload.role]
      .filter(Boolean)
      .join(':'),
  kinds: {
    session_meta: rules({
      keep: [
        ...under('payload', ['cli_version', 'model_provider', 'originator', 'source']),
        ...under('payload.base_instructions.provenance', ['type', 'model']),
      ],
    }),
    turn_context: rules({
      keep: [...under('payload', [...THREAD_SETTINGS, 'effort', 'summary', 'sandbox_policy.type'])],
    }),
    'event_msg:thread_settings_applied': rules({
      keep: under('payload.thread_settings', THREAD_SETTINGS),
    }),
    'event_msg:task_started': rules({ numbers: ['payload.model_context_window'] }),
    'event_msg:task_complete': rules({ text: ['payload.last_agent_message'] }),
    'event_msg:user_message': rules({ text: ['payload.message'] }),
    'event_msg:agent_message': rules({ text: ['payload.message'] }),
    'event_msg:agent_reasoning': rules({ text: ['payload.text'] }),
    'event_msg:item_started': rules({
      keep: under('payload.item', ITEM_KEEP),
      text: under('payload.item', ITEM_TEXT),
      numbers: ['payload.item.exit_code'],
    }),
    'event_msg:item_completed': rules({
      keep: under('payload.item', ITEM_KEEP),
      text: under('payload.item', ITEM_TEXT),
      numbers: ['payload.item.exit_code'],
    }),
    'event_msg:exec_command_begin': rules({ text: ['payload.command'] }),
    'event_msg:exec_command_end': rules({
      text: under('payload', [
        'command',
        'stdout',
        'stderr',
        'aggregated_output',
        'formatted_output',
      ]),
      numbers: ['payload.exit_code'],
    }),
    'event_msg:exec_approval_request': rules({ text: under('payload', ['command', 'reason']) }),
    'event_msg:token_count': rules({
      numbers: [
        'payload.info.model_context_window',
        ...under('payload.info.last_token_usage', ROLLOUT_USAGE),
        ...under('payload.info.total_token_usage', ROLLOUT_USAGE),
      ],
    }),
    token_usage_record: rules({
      numbers: [
        ...under('payload.usage', ROLLOUT_USAGE),
        ...under('payload.turn_token_usage', ROLLOUT_USAGE),
        ...under('payload.thread_token_usage', ROLLOUT_USAGE),
      ],
    }),
    'response_item:message:user': MESSAGE_ITEM,
    'response_item:message:assistant': MESSAGE_ITEM,
    // Developer instructions keep their structure; their text is the tool's own.
    'response_item:message:developer': rules({ keep: MESSAGE_STRUCTURE }),
    'response_item:additional_tools': rules({
      keep: [
        'payload.role',
        'metadata.mcp_attribution.status',
        ...under('payload.tools', ['type', 'tools.type', 'tools.format.type']),
      ],
      words: [schemaTypes('payload.tools.tools.parameters')],
    }),
    'response_item:reasoning': rules({
      keep: ['payload.summary.type'],
      text: ['payload.summary.text'],
    }),
    'response_item:custom_tool_call': rules({
      keep: under('payload', ['name', 'status']),
      text: ['payload.input'],
    }),
    'response_item:custom_tool_call_output': rules({
      keep: ['payload.output.type'],
      ids: ['payload.output.text>chunk_id'],
      text: ['payload.output.text', 'payload.output.text>output'],
      numbers: [
        'payload.output.text>exit_code',
        'payload.output.text>wall_time_seconds',
        'payload.output.text>original_token_count',
      ],
    }),
    'response_item:function_call': rules({
      keep: [...under('payload', ['name', 'status']), 'payload.arguments>sandbox_permissions'],
      text: [
        'payload.arguments',
        ...['cmd', 'command', 'workdir', 'justification'].map((key) => `payload.arguments>${key}`),
      ],
    }),
    'response_item:function_call_output': rules({
      text: ['payload.output', 'payload.output>output'],
      numbers: ['payload.output>exit_code'],
    }),
  },
};

const codexAppServer = {
  common: rules({ keep: ['jsonrpc', 'method'], numbers: ['id'] }),
  kindOf: jsonRpcKind,
  kinds: {
    initialize: rules({ keep: under('params.clientInfo', ['name', 'version']) }),
    'response:initialize': rules(),
    initialized: rules(),
    'account/read': rules(),
    'response:account/read': rules({ keep: ['result.account.type'] }),
    'account/updated': rules(),
    'remoteControl/status/changed': rules({ keep: ['params.status'] }),
    'account/rateLimits/read': rules(),
    'response:account/rateLimits/read': rules({
      keep: [
        'result.rateLimits.limitId',
        'result.rateLimitsByLimitId.*.limitId',
        'result.rateLimitResetCredits.credits.status',
      ],
      numbers: [
        ...under('result.rateLimits', ['primary', 'secondary']).map(
          (p) => `${p}.windowDurationMins`
        ),
        ...under('result.rateLimitsByLimitId.*', ['primary', 'secondary']).map(
          (p) => `${p}.windowDurationMins`
        ),
      ],
      maps: ['result.rateLimitsByLimitId'],
    }),
    'model/list': rules({ numbers: ['params.limit'] }),
    'response:model/list': rules({
      keep: [
        ...under('result.data', [
          'id',
          'model',
          'displayName',
          'defaultReasoningEffort',
          'inputModalities',
          'supportedReasoningEfforts.reasoningEffort',
          'serviceTiers.id',
          'serviceTiers.name',
          'upgradeInfo.model',
        ]),
      ],
    }),
  },
};

/** One policy per recorded stream. */
export const POLICIES = { acp, claudeStdio, claudeHistory, codexRollout, codexAppServer };
