import { Readable, Writable } from 'node:stream';
import {
  type Agent,
  AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  RequestError,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import { CodexRequestError, CodexRpcClient } from './codex-rpc-client';
import {
  collaborationModeListResponseSchema,
  configRequirementsReadResponseSchema,
  knownCodexNotificationSchema,
  knownCodexServerRequestSchema,
  modelListResponseSchema,
  threadReadResponseSchema,
  threadResumeResponseSchema,
  threadStartResponseSchema,
  turnStartResponseSchema,
} from './codex-zod';

type ApprovalPolicy = string;
type ReasoningEffort = string;
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type UserInputAnswers = Record<string, { answers: string[] }>;
type ToolUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

type CodexModelEntry = {
  id: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description?: string;
  }>;
  inputModalities: string[];
  isDefault: boolean;
};

type CollaborationModeEntry = {
  mode: string;
  name: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  developerInstructions: string | null;
};

type CodexMcpServerConfig = {
  enabled: boolean;
  args?: string[];
  command?: string;
  env?: Record<string, string>;
  http_headers?: Record<string, string>;
  transport?: 'sse';
  url?: string;
};

type ToolCallState = {
  toolCallId: string;
  kind: NonNullable<ToolCallUpdate['kind']>;
  title: string;
  locations: Array<{ path: string; line?: number | null }>;
};

type ActiveTurnState = {
  turnId: string;
  cancelRequested: boolean;
  settled: boolean;
  resolve: (value: StopReason) => void;
};

const PENDING_TURN_ID = '__pending_turn__';
const MAX_CLOSE_WATCHER_ATTACH_RETRIES = 50;
const DEFAULT_APPROVAL_POLICIES: ApprovalPolicy[] = ['on-failure', 'on-request', 'never'];
const DEFAULT_SANDBOX_MODES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

type PendingTurnCompletion = {
  stopReason: StopReason;
  errorMessage?: string;
};

type ExecutionPreset = {
  id: string;
  name: string;
  description?: string;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
};

type AdapterSession = {
  sessionId: string;
  threadId: string;
  cwd: string;
  defaults: {
    model: string;
    approvalPolicy: ApprovalPolicy;
    sandboxPolicy: Record<string, unknown>;
    reasoningEffort: ReasoningEffort | null;
    collaborationMode: string;
  };
  activeTurn: ActiveTurnState | null;
  toolCallsByItemId: Map<string, ToolCallState>;
  reasoningDeltaItemIds: Set<string>;
  planTextByItemId: Map<string, string>;
  planApprovalRequestedByTurnId: Set<string>;
  pendingPlanApprovalsByTurnId: Map<string, number>;
  pendingTurnCompletionsByTurnId: Map<string, PendingTurnCompletion>;
  commandApprovalAlways: boolean;
};

type PromptContentBlock = PromptRequest['prompt'][number];
type ThreadReadItem = ReturnType<
  typeof threadReadResponseSchema.parse
>['thread']['turns'][number]['items'][number];
type TurnStartResponse = ReturnType<typeof turnStartResponseSchema.parse>;
type CodexClient = Pick<
  CodexRpcClient,
  'start' | 'stop' | 'request' | 'notify' | 'respondSuccess' | 'respondError'
>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function dedupeStrings<T extends string>(values: Iterable<T>): T[] {
  return Array.from(new Set(values));
}

function humanizeToken(value: string): string {
  return value
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function sanitizeModeName(mode: string): string {
  return mode
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatApprovalPolicyLabel(policy: ApprovalPolicy): string {
  if (policy === 'on-request') {
    return 'On Request';
  }
  if (policy === 'on-failure') {
    return 'On Failure';
  }
  if (policy === 'never') {
    return 'Never Ask';
  }
  if (policy === 'untrusted') {
    return 'Untrusted';
  }
  return humanizeToken(policy);
}

function formatSandboxModeLabel(mode: SandboxMode): string {
  if (mode === 'workspace-write') {
    return 'Workspace Write';
  }
  if (mode === 'read-only') {
    return 'Read-only';
  }
  if (mode === 'danger-full-access') {
    return 'Full Access';
  }
  return humanizeToken(mode);
}

function formatExecutionPresetName(
  approvalPolicy: ApprovalPolicy,
  sandboxMode: SandboxMode
): string {
  if (approvalPolicy === 'never' && sandboxMode === 'danger-full-access') {
    return 'YOLO (Full Access)';
  }

  return `${formatApprovalPolicyLabel(approvalPolicy)} (${formatSandboxModeLabel(sandboxMode)})`;
}

function createWorkspaceWriteSandboxPolicy(cwd: string): Record<string, unknown> {
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    readOnlyAccess: { type: 'fullAccess' },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function createDangerFullAccessSandboxPolicy(): Record<string, unknown> {
  return {
    type: 'dangerFullAccess',
  };
}

function parseSandboxModeFromPolicy(policy: unknown): SandboxMode | null {
  if (!isRecord(policy)) {
    return null;
  }
  const policyType = asString(policy.type);
  if (policyType === 'workspaceWrite') {
    return 'workspace-write';
  }
  if (policyType === 'readOnly') {
    return 'read-only';
  }
  if (policyType === 'dangerFullAccess') {
    return 'danger-full-access';
  }
  return null;
}

function createSandboxPolicyFromMode(mode: SandboxMode, cwd: string): Record<string, unknown> {
  if (mode === 'danger-full-access') {
    return createDangerFullAccessSandboxPolicy();
  }
  if (mode === 'read-only') {
    return {
      type: 'readOnly',
      access: { type: 'fullAccess' },
    };
  }
  return createWorkspaceWriteSandboxPolicy(cwd);
}

function toSessionId(threadId: string): string {
  return `sess_${threadId}`;
}

function toThreadId(sessionId: string): string {
  return sessionId.startsWith('sess_') ? sessionId.slice('sess_'.length) : sessionId;
}

function extractToolCallIdFromUnknown(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return asString(value.callId) ?? asString(value.call_id) ?? null;
}

function resolveToolCallId(params: { itemId: string; source?: unknown }): string {
  return extractToolCallIdFromUnknown(params.source) ?? params.itemId;
}

function isPlanLikeMode(mode: string): boolean {
  return /plan/i.test(mode);
}

const PLAN_EXIT_MODE_PREFERENCE = ['default', 'code', 'acceptEdits', 'ask'] as const;

const PLAN_TEXT_MAX_DEPTH = 8;
const PLAN_TEXT_PREFERRED_KEYS = [
  'plan',
  'text',
  'content',
  'markdown',
  'value',
  'message',
] as const;
const REASONING_TEXT_MAX_DEPTH = 8;
const REASONING_TEXT_PREFERRED_KEYS = [
  'summary',
  'summaryText',
  'text',
  'delta',
  'message',
  'content',
  'reasoning',
] as const;

function extractFirstPlanText(values: Iterable<unknown>, depth: number): string | null {
  for (const entry of values) {
    const extracted = extractPlanTextLocal(entry, depth + 1);
    if (extracted) {
      return extracted;
    }
  }
  return null;
}

function extractPlanTextFromRecord(value: Record<string, unknown>, depth: number): string | null {
  const preferred = extractFirstPlanText(
    PLAN_TEXT_PREFERRED_KEYS.map((key) => value[key]),
    depth
  );
  if (preferred) {
    return preferred;
  }
  return extractFirstPlanText(Object.values(value), depth);
}

function extractPlanTextLocal(value: unknown, depth = 0): string | null {
  if (depth > PLAN_TEXT_MAX_DEPTH) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : null;
  }

  if (Array.isArray(value)) {
    return extractFirstPlanText(value, depth);
  }

  if (!isRecord(value)) {
    return null;
  }

  return extractPlanTextFromRecord(value, depth);
}

function collectReasoningText(values: string[], value: unknown, depth = 0): void {
  if (depth > REASONING_TEXT_MAX_DEPTH) {
    return;
  }

  if (typeof value === 'string') {
    if (value.trim().length > 0) {
      values.push(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReasoningText(values, entry, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const key of REASONING_TEXT_PREFERRED_KEYS) {
    collectReasoningText(values, value[key], depth + 1);
  }
}

function extractReasoningTextLocal(value: unknown): string | null {
  const collected: string[] = [];
  collectReasoningText(collected, value);
  if (collected.length === 0) {
    return null;
  }

  return dedupeStrings(collected).join('\n\n');
}

function toMcpEnvRecord(envVars: Array<{ name: string; value: string }>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of envVars) {
    env[entry.name] = entry.value;
  }
  return env;
}

function toMcpHeadersRecord(
  headers: Array<{ name: string; value: string }>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers) {
    result[header.name] = header.value;
  }
  return result;
}

function sanitizeMcpServerName(name: string, index: number): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : `mcp_server_${index + 1}`;
}

function toCodexMcpServerConfig(server: McpServer): CodexMcpServerConfig {
  if ('command' in server) {
    const env = toMcpEnvRecord(server.env);
    return {
      enabled: true,
      command: server.command,
      args: [...server.args],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  const httpHeaders = toMcpHeadersRecord(server.headers);
  return {
    enabled: true,
    url: server.url,
    ...(Object.keys(httpHeaders).length > 0 ? { http_headers: httpHeaders } : {}),
    ...(server.type === 'sse' ? { transport: 'sse' as const } : {}),
  };
}

function toCodexMcpConfigMap(mcpServers: McpServer[]): Record<string, CodexMcpServerConfig> {
  const mcpServersByName: Record<string, CodexMcpServerConfig> = {};
  const usedNames = new Set<string>();

  for (const [index, server] of mcpServers.entries()) {
    const baseName = sanitizeMcpServerName(server.name, index);
    let nextName = baseName;
    let suffix = 2;
    while (usedNames.has(nextName)) {
      nextName = `${baseName}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(nextName);
    mcpServersByName[nextName] = toCodexMcpServerConfig(server);
  }

  return mcpServersByName;
}

function buildToolUserInputPermissionOptions(
  questions: ToolUserInputQuestion[]
): Array<{ optionId: string; name: string; kind: 'allow_once' | 'reject_once' }> {
  if (questions.length !== 1) {
    return [
      { optionId: 'allow_once', name: 'Submit', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Cancel', kind: 'reject_once' },
    ];
  }

  const firstQuestionWithOptions = questions.find(
    (question) => Array.isArray(question.options) && question.options.length > 0
  );
  if (!firstQuestionWithOptions?.options) {
    return [
      { optionId: 'allow_once', name: 'Submit', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Cancel', kind: 'reject_once' },
    ];
  }

  const mappedOptions: Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'reject_once';
  }> = firstQuestionWithOptions.options.slice(0, 6).map((option, index) => ({
    optionId: `answer_${index}`,
    name: option.label,
    kind: 'allow_once' as const,
  }));
  mappedOptions.push({ optionId: 'reject_once', name: 'Cancel', kind: 'reject_once' });
  return mappedOptions;
}

function buildToolUserInputAnswers(params: {
  questions: ToolUserInputQuestion[];
  permission: RequestPermissionResponse;
  selectedOptionId: string | null;
}): UserInputAnswers {
  if (params.selectedOptionId === null || params.selectedOptionId === 'reject_once') {
    return {};
  }

  const parsedAnswers = parseToolUserInputAnswersFromPermissionMeta({
    questions: params.questions,
    permission: params.permission,
  });
  if (parsedAnswers) {
    return parsedAnswers;
  }

  if (params.questions.length !== 1) {
    throw new Error('Missing structured answers for multi-question requestUserInput');
  }

  const selectedIndex = params.selectedOptionId.startsWith('answer_')
    ? Number.parseInt(params.selectedOptionId.slice('answer_'.length), 10)
    : Number.NaN;

  const answers: UserInputAnswers = {};
  const [question] = params.questions;
  if (!(question && Array.isArray(question.options)) || question.options.length === 0) {
    return answers;
  }

  const selectedOption = Number.isNaN(selectedIndex)
    ? question.options[0]
    : (question.options[selectedIndex] ?? question.options[0]);
  if (!selectedOption) {
    return answers;
  }

  answers[question.id] = { answers: [selectedOption.label] };
  return answers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolUserInputAnswersFromPermissionMeta(params: {
  questions: ToolUserInputQuestion[];
  permission: RequestPermissionResponse;
}): UserInputAnswers | null {
  const meta = params.permission._meta;
  if (!isRecord(meta)) {
    return null;
  }

  const factoryFactoryMeta = isRecord(meta.factoryFactory) ? meta.factoryFactory : null;
  const answersRaw = (factoryFactoryMeta?.toolUserInputAnswers ?? meta.toolUserInputAnswers) as
    | unknown
    | undefined;
  if (!isRecord(answersRaw)) {
    return null;
  }

  const knownQuestionIds = new Set(params.questions.map((question) => question.id));
  const answers: UserInputAnswers = {};
  for (const [questionId, value] of Object.entries(answersRaw)) {
    if (!knownQuestionIds.has(questionId)) {
      continue;
    }

    const values = (Array.isArray(value) ? value : [value])
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (values.length === 0) {
      continue;
    }

    answers[questionId] = { answers: values };
  }

  return answers;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function sanitizeCommandToken(token: string): string {
  return token.replace(/^['"]|['"]$/g, '').trim();
}

function tokenizeCommand(command: string): string[] {
  return (command.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) ?? [])
    .map((token) => sanitizeCommandToken(token))
    .filter((token) => token.length > 0);
}

function commandName(token: string): string {
  const unix = token.split('/').at(-1) ?? token;
  return (unix.split('\\').at(-1) ?? unix).toLowerCase();
}

function isLikelyPathToken(token: string): boolean {
  if (!token || token.startsWith('-')) {
    return false;
  }
  if (
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('/') ||
    token.startsWith('~')
  ) {
    return true;
  }
  return (
    token.includes('/') ||
    token.includes('\\') ||
    token.endsWith('.') ||
    /\.[a-z0-9]+$/i.test(token)
  );
}

function normalizeLocationPath(pathToken: string, cwd: string): string {
  if (pathToken.startsWith('/')) {
    return pathToken;
  }
  if (pathToken.startsWith('~')) {
    return pathToken;
  }
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
  return `${base}/${pathToken}`;
}

const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more']);
const LIST_OR_FIND_COMMANDS = new Set(['ls', 'tree', 'find', 'fd']);
const GREP_LIKE_COMMANDS = new Set(['rg', 'ripgrep', 'grep', 'ag']);

type CommandDisplayContext = {
  command: string;
  firstCommand: string;
  nonFlagArgs: string[];
  pathArg: string | null;
  cwd: string;
  locations: Array<{ path: string }>;
};

function resolveCommandDisplay(params: { command: string | null; cwd: string }): {
  title: string;
  kind: NonNullable<ToolCallUpdate['kind']>;
  locations: Array<{ path: string }>;
} {
  const context = buildCommandDisplayContext(params.command, params.cwd);
  if (!context) {
    return { title: 'commandExecution', kind: 'execute', locations: [] };
  }
  return resolveCommandDisplayFromContext(context);
}

function buildCommandDisplayContext(
  rawCommand: string | null,
  cwd: string
): CommandDisplayContext | null {
  const command = rawCommand?.trim();
  if (!command) {
    return null;
  }
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return null;
  }

  const [firstToken] = tokens;
  if (!firstToken) {
    return null;
  }
  const firstCommand = commandName(firstToken);
  const nonFlagArgs = tokens.slice(1).filter((token) => !token.startsWith('-'));
  const pathArg = nonFlagArgs.find(isLikelyPathToken) ?? null;
  const commandPath = pathArg ? normalizeLocationPath(pathArg, cwd) : null;
  const locations = commandPath ? [{ path: commandPath }] : [];
  return {
    command,
    firstCommand,
    nonFlagArgs,
    pathArg,
    cwd,
    locations,
  };
}

function resolveCommandDisplayFromContext(context: CommandDisplayContext): {
  title: string;
  kind: NonNullable<ToolCallUpdate['kind']>;
  locations: Array<{ path: string }>;
} {
  if (READ_COMMANDS.has(context.firstCommand)) {
    const label = context.pathArg ?? context.command;
    return { title: `Read ${label}`, kind: 'read', locations: context.locations };
  }

  if (LIST_OR_FIND_COMMANDS.has(context.firstCommand)) {
    const target = context.pathArg
      ? normalizeLocationPath(context.pathArg, context.cwd)
      : context.cwd;
    const title =
      context.firstCommand === 'find' || context.firstCommand === 'fd'
        ? `Search ${target}`
        : `List ${target}`;
    return { title, kind: 'search', locations: context.locations };
  }

  if (GREP_LIKE_COMMANDS.has(context.firstCommand)) {
    const query = context.nonFlagArgs.find((token) => !isLikelyPathToken(token));
    const target = context.pathArg ? ` in ${context.pathArg}` : '';
    const title = query ? `Search ${query}${target}` : `Search ${context.command}`;
    return { title, kind: 'search', locations: context.locations };
  }

  return { title: context.command, kind: 'execute', locations: context.locations };
}

function dedupeLocations(
  locations: Array<{ path: string; line?: number | null }>
): Array<{ path: string; line?: number | null }> {
  const seen = new Set<string>();
  const result: Array<{ path: string; line?: number | null }> = [];
  for (const location of locations) {
    const key = `${location.path}:${location.line ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(location);
  }
  return result;
}

function parseTextFromPromptBlock(block: PromptContentBlock): string {
  if (block.type === 'text') {
    return block.text;
  }

  if (block.type === 'resource_link') {
    return `[ACP_RESOURCE_LINK uri="${block.uri}" name="${block.name}"]\n[/ACP_RESOURCE_LINK]`;
  }

  if (block.type === 'resource') {
    const resource = block.resource;
    const mime = resource.mimeType ?? 'unknown';
    const payload =
      'text' in resource && typeof resource.text === 'string'
        ? resource.text
        : 'blob' in resource && typeof resource.blob === 'string'
          ? resource.blob
          : JSON.stringify(resource);
    return `[ACP_RESOURCE uri="${resource.uri}" mime="${mime}"]\n${payload}\n[/ACP_RESOURCE]`;
  }

  if (block.type === 'image') {
    const mime = block.mimeType ?? 'application/octet-stream';
    return `[ACP_IMAGE mime="${mime}" bytes=${block.data.length}]`;
  }

  return JSON.stringify(block);
}

function toToolStatus(status: unknown): ToolCallUpdate['status'] | undefined {
  if (status === 'inProgress') {
    return 'in_progress';
  }
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'failed' || status === 'declined') {
    return 'failed';
  }
  return undefined;
}

function createCollaborationModeConfigOption(
  currentMode: string,
  collaborationModes: CollaborationModeEntry[]
): SessionConfigOption {
  const options = collaborationModes
    .filter((entry) => isNonEmptyString(entry.mode))
    .map((entry) => ({
      value: entry.mode,
      name: entry.name,
    }));

  if (!options.some((option) => option.value === currentMode)) {
    options.unshift({ value: currentMode, name: sanitizeModeName(currentMode) });
  }

  return {
    id: 'mode',
    category: 'mode',
    name: 'Collaboration Mode',
    type: 'select',
    currentValue: currentMode,
    options,
  };
}

function createModelConfigOption(
  currentModel: string,
  modelCatalog: CodexModelEntry[]
): SessionConfigOption {
  const options: SessionConfigSelectOption[] = modelCatalog.map((model) => ({
    value: model.id,
    name: model.displayName,
    description: model.description,
  }));

  if (!options.some((option) => option.value === currentModel)) {
    options.unshift({ value: currentModel, name: currentModel });
  }

  return {
    id: 'model',
    category: 'model',
    name: 'Model',
    type: 'select',
    currentValue: currentModel,
    options,
  };
}

function createReasoningEffortConfigOption(
  currentReasoningEffort: ReasoningEffort | null,
  modelCatalog: CodexModelEntry[],
  currentModel: string
): SessionConfigOption | null {
  const modelEntry = modelCatalog.find((model) => model.id === currentModel);
  if (!modelEntry) {
    return null;
  }

  const supportedEntries = modelEntry.supportedReasoningEfforts.filter((entry) =>
    isNonEmptyString(entry.reasoningEffort)
  );
  if (supportedEntries.length === 0) {
    return null;
  }

  const supportedByValue = new Map<string, string | undefined>();
  for (const entry of supportedEntries) {
    if (!supportedByValue.has(entry.reasoningEffort)) {
      supportedByValue.set(entry.reasoningEffort, entry.description);
    }
  }

  const supportedValues = [...supportedByValue.keys()];
  const resolvedCurrent =
    currentReasoningEffort && supportedByValue.has(currentReasoningEffort)
      ? currentReasoningEffort
      : supportedByValue.has(modelEntry.defaultReasoningEffort)
        ? modelEntry.defaultReasoningEffort
        : supportedValues[0];

  if (!resolvedCurrent) {
    return null;
  }

  return {
    id: 'reasoning_effort',
    category: 'thought_level',
    name: 'Reasoning Effort',
    type: 'select',
    currentValue: resolvedCurrent,
    options: supportedValues.map((value) => ({
      value,
      name: value,
      ...(supportedByValue.get(value) ? { description: supportedByValue.get(value) } : {}),
    })),
  };
}

function createExecutionModeConfigOption(
  currentPresetId: ExecutionPreset['id'],
  presets: ExecutionPreset[]
): SessionConfigOption {
  return {
    id: 'execution_mode',
    category: 'permission',
    name: 'Execution Mode',
    type: 'select',
    currentValue: currentPresetId,
    options: presets.map((preset) => ({
      value: preset.id,
      name: preset.name,
      ...(preset.description ? { description: preset.description } : {}),
    })),
  };
}

function toExecutionPresetId(approvalPolicy: ApprovalPolicy, sandboxMode: SandboxMode): string {
  return JSON.stringify([approvalPolicy, sandboxMode]);
}

export class CodexAppServerAcpAdapter implements Agent {
  private readonly connection: AgentSideConnection;
  private readonly codex: CodexClient;
  private readonly sessions = new Map<string, AdapterSession>();
  private readonly sessionIdByThreadId = new Map<string, string>();
  private modelCatalog: CodexModelEntry[] = [];
  private allowedApprovalPolicies: ApprovalPolicy[] = [];
  private allowedSandboxModes: SandboxMode[] = [];
  private collaborationModes: CollaborationModeEntry[] = [];
  private readonly mcpServersByThreadId = new Map<string, Record<string, CodexMcpServerConfig>>();
  private appliedMcpServerConfigJson = '{}';

  constructor(connection: AgentSideConnection, codexClient?: CodexClient) {
    this.connection = connection;
    this.codex =
      codexClient ??
      new CodexRpcClient({
        cwd: process.cwd(),
        env: { ...process.env },
        onStderr: (line) => {
          process.stderr.write(line);
        },
        onNotification: (notification) => {
          void this.handleCodexNotification(notification.method, notification.params);
        },
        onRequest: (request) => {
          void this.handleCodexServerRequest(request).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.codex.respondError(request.id, {
              code: -32_600,
              message: 'Failed to process codex approval request',
              data: { error: message },
            });
          });
        },
        onProtocolError: (error) => {
          process.stderr.write(`[codex-app-server-acp] protocol-error: ${error.reason}\n`);
        },
      });

    this.monitorConnectionClose();
  }

  private monitorConnectionClose(): void {
    // AgentSideConnection initializes internals after toAgent(); defer watcher
    // attachment and retry if closed isn't readable yet.
    let attachAttempts = 0;
    const attachCloseWatcher = () => {
      try {
        void this.connection.closed
          .finally(async () => {
            await this.codex.stop();
          })
          .catch(() => {
            // Ignore close-watcher errors and still attempt subprocess shutdown.
          });
      } catch {
        attachAttempts += 1;
        if (attachAttempts >= MAX_CLOSE_WATCHER_ATTACH_RETRIES) {
          process.stderr.write(
            `[codex-app-server-acp] failed to attach close watcher after ${MAX_CLOSE_WATCHER_ATTACH_RETRIES} attempts\n`
          );
          void this.codex.stop();
          return;
        }
        const retryTimer = setTimeout(attachCloseWatcher, 0);
        retryTimer.unref?.();
      }
    };

    queueMicrotask(attachCloseWatcher);
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.codex.start();

    await this.codex.request('initialize', {
      clientInfo: {
        name: 'factory-factory-codex-app-server-acp',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.codex.notify('initialized');

    const configRequirements = await this.loadConfigRequirements();
    this.allowedApprovalPolicies = configRequirements.allowedApprovalPolicies;
    this.allowedSandboxModes = configRequirements.allowedSandboxModes;
    this.collaborationModes = await this.loadCollaborationModes();
    this.modelCatalog = await this.loadModelCatalog();

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: 'factory-factory-codex-app-server-acp',
        version: '0.1.0',
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          embeddedContext: true,
        },
      },
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const defaultModel = this.resolveDefaultModel();

    const responseRaw = await this.codex.request('thread/start', {
      cwd: params.cwd,
      model: defaultModel,
    });

    const response = threadStartResponseSchema.parse(responseRaw);
    const sessionId = toSessionId(response.thread.id);
    const approvalPolicy = this.requireApprovalPolicy(response.approvalPolicy, 'thread/start');
    const model = this.resolveSessionModel(response.model, defaultModel);
    const sandboxPolicy = this.resolveSandboxPolicy(response.sandbox, params.cwd);
    const reasoningEffort = this.resolveReasoningEffortForModel(model, response.reasoningEffort);
    const collaborationMode = this.resolveDefaultCollaborationMode();

    const session: AdapterSession = {
      sessionId,
      threadId: response.thread.id,
      cwd: params.cwd,
      defaults: {
        model,
        approvalPolicy,
        sandboxPolicy,
        reasoningEffort,
        collaborationMode,
      },
      activeTurn: null,
      toolCallsByItemId: new Map(),
      reasoningDeltaItemIds: new Set(),
      planTextByItemId: new Map(),
      planApprovalRequestedByTurnId: new Set(),
      pendingPlanApprovalsByTurnId: new Map(),
      pendingTurnCompletionsByTurnId: new Map(),
      commandApprovalAlways: false,
    };

    this.sessions.set(sessionId, session);
    this.sessionIdByThreadId.set(session.threadId, sessionId);
    try {
      await this.applyMcpServers(session.threadId, params.mcpServers);
    } catch (error) {
      this.sessions.delete(sessionId);
      this.sessionIdByThreadId.delete(session.threadId);
      throw error;
    }

    return {
      sessionId,
      configOptions: this.buildConfigOptions(session),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const threadId = toThreadId(params.sessionId);
    const responseRaw = await this.codex.request('thread/resume', {
      threadId,
      cwd: params.cwd,
    });
    const response = threadResumeResponseSchema.parse(responseRaw);
    const approvalPolicy = this.requireApprovalPolicy(response.approvalPolicy, 'thread/resume');
    const model = this.resolveSessionModel(response.model, this.resolveDefaultModel());
    const sandboxPolicy = this.resolveSandboxPolicy(response.sandbox, params.cwd);
    const reasoningEffort = this.resolveReasoningEffortForModel(model, response.reasoningEffort);
    const collaborationMode = this.resolveDefaultCollaborationMode();

    const session: AdapterSession = {
      sessionId: params.sessionId,
      threadId: response.thread.id,
      cwd: params.cwd,
      defaults: {
        model,
        approvalPolicy,
        sandboxPolicy,
        reasoningEffort,
        collaborationMode,
      },
      activeTurn: null,
      toolCallsByItemId: new Map(),
      reasoningDeltaItemIds: new Set(),
      planTextByItemId: new Map(),
      planApprovalRequestedByTurnId: new Set(),
      pendingPlanApprovalsByTurnId: new Map(),
      pendingTurnCompletionsByTurnId: new Map(),
      commandApprovalAlways: false,
    };

    this.sessions.set(session.sessionId, session);
    this.sessionIdByThreadId.set(session.threadId, session.sessionId);
    try {
      await this.applyMcpServers(session.threadId, params.mcpServers);
      await this.replayThreadHistory(session.sessionId, session.threadId);
    } catch (error) {
      try {
        await this.removeMcpServersForThread(session.threadId);
      } catch {
        // Preserve the original session load failure.
      }
      this.sessions.delete(session.sessionId);
      this.sessionIdByThreadId.delete(session.threadId);
      throw error;
    }

    return {
      configOptions: this.buildConfigOptions(session),
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    await Promise.resolve();
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    await Promise.resolve();
    const session = this.requireSession(params.sessionId);
    const availableModes = this.getCollaborationModeValues(session.defaults.collaborationMode);
    if (!availableModes.includes(params.modeId)) {
      throw RequestError.invalidParams({
        modeId: params.modeId,
      });
    }

    session.defaults.collaborationMode = params.modeId;

    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    await Promise.resolve();
    const session = this.requireSession(params.sessionId);

    switch (params.configId) {
      case 'mode': {
        const availableModes = this.getCollaborationModeValues(session.defaults.collaborationMode);
        if (!availableModes.includes(params.value)) {
          throw RequestError.invalidParams({
            configId: params.configId,
            value: params.value,
          });
        }
        session.defaults.collaborationMode = params.value;
        break;
      }
      case 'execution_mode': {
        const presets = this.getExecutionPresets(session);
        const selectedPreset = presets.find((preset) => preset.id === params.value);
        if (!selectedPreset) {
          throw RequestError.invalidParams({
            configId: params.configId,
            value: params.value,
          });
        }
        session.defaults.approvalPolicy = selectedPreset.approvalPolicy;
        session.defaults.sandboxPolicy = createSandboxPolicyFromMode(
          selectedPreset.sandboxMode,
          session.cwd
        );
        break;
      }
      case 'model': {
        if (!this.modelCatalog.some((model) => model.id === params.value)) {
          throw RequestError.invalidParams({
            configId: params.configId,
            value: params.value,
          });
        }
        session.defaults.model = params.value;
        session.defaults.reasoningEffort = this.resolveReasoningEffortForModel(
          session.defaults.model,
          session.defaults.reasoningEffort
        );
        break;
      }
      case 'reasoning_effort':
      case 'thought_level': {
        const modelEntry = this.modelCatalog.find((model) => model.id === session.defaults.model);
        const supportedReasoningEfforts = modelEntry?.supportedReasoningEfforts ?? [];
        const supportedValues = new Set(
          supportedReasoningEfforts
            .map((entry) => entry.reasoningEffort)
            .filter((effort): effort is string => isNonEmptyString(effort))
        );
        if (!supportedValues.has(params.value)) {
          throw RequestError.invalidParams({
            configId: params.configId,
            value: params.value,
          });
        }
        session.defaults.reasoningEffort = params.value;
        break;
      }
      default:
        throw RequestError.invalidParams({ configId: params.configId });
    }

    return {
      configOptions: this.buildConfigOptions(session),
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (session.activeTurn) {
      throw RequestError.invalidRequest({
        reason: 'A turn is already in progress for this session',
      });
    }

    const input = params.prompt
      .map((block) => parseTextFromPromptBlock(block))
      .filter((text) => text.trim().length > 0)
      .map((text) => ({ type: 'text', text, text_elements: [] as [] }));

    if (input.length === 0) {
      throw RequestError.invalidParams({
        reason: 'Prompt must include at least one non-empty content block',
      });
    }

    const stopReasonPromise = this.createPendingTurnPromise(session);

    try {
      const turnStartParams: Record<string, unknown> = {
        threadId: session.threadId,
        input,
        cwd: session.cwd,
        approvalPolicy: session.defaults.approvalPolicy,
        sandboxPolicy: session.defaults.sandboxPolicy,
        model: session.defaults.model,
        effort: session.defaults.reasoningEffort,
      };
      const collaborationModeParams = this.resolveTurnCollaborationMode(session);
      if (collaborationModeParams) {
        turnStartParams.collaborationMode = collaborationModeParams;
      }

      const turnStartRaw = await this.codex.request('turn/start', turnStartParams);

      const turnStart = turnStartResponseSchema.parse(turnStartRaw);
      await this.bindTurnToActivePrompt(session, turnStart.turn.id);
      const immediateStopReason = await this.resolveImmediateTurnStopReason(session, turnStart);
      if (immediateStopReason) {
        this.settleTurn(session, immediateStopReason);
        return { stopReason: await stopReasonPromise };
      }

      if (this.isActiveTurnCancelRequested(session)) {
        await this.requestTurnInterrupt(session);
      }

      return { stopReason: await stopReasonPromise };
    } catch (error) {
      if (error instanceof CodexRequestError && error.code === -32_001) {
        await this.emitTurnFailureMessage(
          session.sessionId,
          error.message || 'Codex app-server request failed with overload response.'
        );
        this.settleTurn(session, 'end_turn');
        return { stopReason: await stopReasonPromise };
      }

      this.settleTurn(session, 'end_turn');
      throw error;
    }
  }

  private async resolveImmediateTurnStopReason(
    session: AdapterSession,
    turnStart: TurnStartResponse
  ): Promise<StopReason | null> {
    const status = turnStart.turn.status;
    if (status === 'interrupted') {
      return 'cancelled';
    }

    if (status === 'failed') {
      const failureMessage = asString(
        isRecord(turnStart.turn.error) ? turnStart.turn.error.message : null
      );
      if (failureMessage) {
        await this.emitTurnFailureMessage(session.sessionId, failureMessage);
      }
      return 'end_turn';
    }

    if (status === 'completed') {
      return 'end_turn';
    }

    return null;
  }

  private createPendingTurnPromise(session: AdapterSession): Promise<StopReason> {
    return new Promise<StopReason>((resolve) => {
      session.activeTurn = {
        turnId: PENDING_TURN_ID,
        cancelRequested: false,
        settled: false,
        resolve,
      };
    });
  }

  private async bindTurnToActivePrompt(session: AdapterSession, turnId: string): Promise<void> {
    if (!session.activeTurn || session.activeTurn.settled) {
      return;
    }

    session.activeTurn.turnId = turnId;
    const pendingCompletion = session.pendingTurnCompletionsByTurnId.get(turnId);
    if (!pendingCompletion) {
      return;
    }

    session.pendingTurnCompletionsByTurnId.delete(turnId);
    if (pendingCompletion.errorMessage) {
      await this.emitTurnFailureMessage(session.sessionId, pendingCompletion.errorMessage);
    }
    this.settleTurn(session, pendingCompletion.stopReason);
  }

  private async requestTurnInterrupt(session: AdapterSession): Promise<void> {
    if (!session.activeTurn || session.activeTurn.turnId === PENDING_TURN_ID) {
      return;
    }

    await this.codex.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.activeTurn.turnId,
    });
  }

  private isActiveTurnCancelRequested(session: AdapterSession): boolean {
    return Boolean(session.activeTurn?.cancelRequested);
  }

  private async emitTurnFailureMessage(sessionId: string, errorMessage: string): Promise<void> {
    await this.emitSessionUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: errorMessage,
      },
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session?.activeTurn) {
      return;
    }

    session.activeTurn.cancelRequested = true;
    if (session.activeTurn.turnId === PENDING_TURN_ID) {
      return;
    }

    try {
      await this.requestTurnInterrupt(session);
    } catch {
      this.settleTurn(session, 'cancelled');
    }
  }

  private resolveDefaultModel(): string {
    const preferred = this.modelCatalog.find((model) => model.isDefault);
    const fallback = this.modelCatalog[0]?.id;
    if (preferred?.id) {
      return preferred.id;
    }
    if (fallback) {
      return fallback;
    }
    throw new Error('Codex app-server model/list returned no models');
  }

  private buildMergedMcpServersConfig(): Record<string, CodexMcpServerConfig> {
    const merged: Record<string, CodexMcpServerConfig> = {};
    const threadIds = [...this.mcpServersByThreadId.keys()].sort();
    for (const threadId of threadIds) {
      const threadConfig = this.mcpServersByThreadId.get(threadId);
      if (!threadConfig) {
        continue;
      }
      for (const serverName of Object.keys(threadConfig).sort()) {
        const nextServerConfig = threadConfig[serverName];
        if (!nextServerConfig) {
          continue;
        }
        const existingConfig = merged[serverName];
        if (!existingConfig) {
          merged[serverName] = nextServerConfig;
          continue;
        }
        if (JSON.stringify(existingConfig) === JSON.stringify(nextServerConfig)) {
          continue;
        }
        merged[`${serverName}__${threadId}`] = nextServerConfig;
      }
    }
    return merged;
  }

  private async writeMergedMcpServersConfig(): Promise<void> {
    const mergedConfig = this.buildMergedMcpServersConfig();
    const nextConfigJson = JSON.stringify(mergedConfig);
    if (nextConfigJson === this.appliedMcpServerConfigJson) {
      return;
    }

    await this.codex.request('config/value/write', {
      keyPath: 'mcp_servers',
      value: mergedConfig,
      mergeStrategy: 'replace',
    });
    await this.codex.request('config/mcpServer/reload', {});
    this.appliedMcpServerConfigJson = nextConfigJson;
  }

  private async removeMcpServersForThread(threadId: string): Promise<void> {
    if (!this.mcpServersByThreadId.has(threadId)) {
      return;
    }
    this.mcpServersByThreadId.delete(threadId);
    await this.writeMergedMcpServersConfig();
  }

  private async applyMcpServers(threadId: string, mcpServers: McpServer[]): Promise<void> {
    const previousConfig = this.mcpServersByThreadId.get(threadId);
    const hadPreviousConfig = this.mcpServersByThreadId.has(threadId);
    const threadConfig = toCodexMcpConfigMap(mcpServers);
    if (Object.keys(threadConfig).length === 0) {
      this.mcpServersByThreadId.delete(threadId);
    } else {
      this.mcpServersByThreadId.set(threadId, threadConfig);
    }

    try {
      await this.writeMergedMcpServersConfig();
    } catch (error) {
      if (hadPreviousConfig && previousConfig) {
        this.mcpServersByThreadId.set(threadId, previousConfig);
      } else {
        this.mcpServersByThreadId.delete(threadId);
      }
      throw error;
    }
  }

  private buildConfigOptions(session: AdapterSession): SessionConfigOption[] {
    const executionPresets = this.getExecutionPresets(session);
    const currentExecutionPreset = this.resolveExecutionPresetId(session, executionPresets);
    const configOptions: SessionConfigOption[] = [
      createModelConfigOption(session.defaults.model, this.modelCatalog),
      createCollaborationModeConfigOption(
        session.defaults.collaborationMode,
        this.collaborationModes
      ),
      createExecutionModeConfigOption(currentExecutionPreset, executionPresets),
    ];

    const reasoningOption = createReasoningEffortConfigOption(
      session.defaults.reasoningEffort,
      this.modelCatalog,
      session.defaults.model
    );
    if (reasoningOption) {
      configOptions.push(reasoningOption);
    }

    return configOptions;
  }

  private requireApprovalPolicy(
    approvalPolicy: unknown,
    source: 'thread/start' | 'thread/resume'
  ): ApprovalPolicy {
    if (!isNonEmptyString(approvalPolicy)) {
      throw new Error(`Codex ${source} response did not include approvalPolicy`);
    }
    return approvalPolicy;
  }

  private resolveSessionModel(model: unknown, fallbackModel: string): string {
    return isNonEmptyString(model) ? model : fallbackModel;
  }

  private resolveSandboxPolicy(sandbox: unknown, cwd: string): Record<string, unknown> {
    return isRecord(sandbox) ? sandbox : createWorkspaceWriteSandboxPolicy(cwd);
  }

  private resolveDefaultCollaborationMode(): string {
    if (this.collaborationModes.length === 0) {
      throw new Error('Codex collaborationMode/list returned no modes');
    }
    const preferredDefault = this.collaborationModes.find((entry) => entry.mode === 'default');
    const firstMode = this.collaborationModes[0]?.mode;
    if (!firstMode) {
      throw new Error('Codex collaborationMode/list returned an invalid mode entry');
    }
    return preferredDefault?.mode ?? firstMode;
  }

  private resolveTurnCollaborationMode(session: AdapterSession): Record<string, unknown> | null {
    const modeEntry = this.collaborationModes.find(
      (entry) => entry.mode === session.defaults.collaborationMode
    );

    return {
      mode: modeEntry?.mode ?? session.defaults.collaborationMode,
      settings: {
        model: modeEntry?.model ?? session.defaults.model,
        reasoning_effort: modeEntry?.reasoningEffort ?? session.defaults.reasoningEffort,
        developer_instructions: modeEntry?.developerInstructions ?? null,
      },
    };
  }

  private resolveReasoningEffortForModel(
    modelId: string,
    candidateReasoningEffort: unknown
  ): ReasoningEffort | null {
    const modelEntry = this.modelCatalog.find((entry) => entry.id === modelId);
    if (!modelEntry) {
      return null;
    }

    const supportedEntries = modelEntry.supportedReasoningEfforts.filter((entry) =>
      isNonEmptyString(entry.reasoningEffort)
    );
    if (supportedEntries.length === 0) {
      return null;
    }

    const supportedValues = dedupeStrings(supportedEntries.map((entry) => entry.reasoningEffort));
    if (
      isNonEmptyString(candidateReasoningEffort) &&
      supportedValues.includes(candidateReasoningEffort)
    ) {
      return candidateReasoningEffort;
    }
    if (supportedValues.includes(modelEntry.defaultReasoningEffort)) {
      return modelEntry.defaultReasoningEffort;
    }
    return supportedValues[0] ?? null;
  }

  private getCollaborationModeValues(currentMode: string): string[] {
    const values = this.collaborationModes
      .map((entry) => entry.mode)
      .filter((mode): mode is string => isNonEmptyString(mode));
    if (!values.includes(currentMode)) {
      values.unshift(currentMode);
    }
    return dedupeStrings(values);
  }

  private resolveCurrentSandboxMode(session: AdapterSession): SandboxMode {
    const currentSandboxMode = parseSandboxModeFromPolicy(session.defaults.sandboxPolicy);
    if (currentSandboxMode) {
      return currentSandboxMode;
    }
    const allowedSandboxMode = this.allowedSandboxModes[0];
    if (allowedSandboxMode) {
      return allowedSandboxMode;
    }
    throw new Error('Unable to resolve current sandbox mode for execution-mode options');
  }

  private getExecutionPresets(session: AdapterSession): ExecutionPreset[] {
    const currentSandboxMode = this.resolveCurrentSandboxMode(session);
    const policies =
      this.allowedApprovalPolicies.length > 0
        ? this.allowedApprovalPolicies
        : [session.defaults.approvalPolicy];
    const sandboxModes =
      this.allowedSandboxModes.length > 0 ? this.allowedSandboxModes : [currentSandboxMode];

    const presets: ExecutionPreset[] = [];
    const seen = new Set<string>();
    const addPreset = (
      approvalPolicy: ApprovalPolicy,
      sandboxMode: SandboxMode,
      description?: string
    ): void => {
      const id = toExecutionPresetId(approvalPolicy, sandboxMode);
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      presets.push({
        id,
        name: formatExecutionPresetName(approvalPolicy, sandboxMode),
        ...(description ? { description } : {}),
        approvalPolicy,
        sandboxMode,
      });
    };

    addPreset(
      session.defaults.approvalPolicy,
      currentSandboxMode,
      `Current session: ${formatExecutionPresetName(
        session.defaults.approvalPolicy,
        currentSandboxMode
      )}`
    );
    for (const policy of policies) {
      for (const sandboxMode of sandboxModes) {
        addPreset(policy, sandboxMode);
      }
    }

    return presets;
  }

  private resolveExecutionPresetId(
    session: AdapterSession,
    presets: ExecutionPreset[]
  ): ExecutionPreset['id'] {
    const currentSandboxMode = this.resolveCurrentSandboxMode(session);
    const currentPresetId = toExecutionPresetId(
      session.defaults.approvalPolicy,
      currentSandboxMode
    );
    const fallbackPresetId = presets[0]?.id;
    if (!fallbackPresetId) {
      throw new Error('Execution-mode presets are unavailable for this session');
    }
    return presets.some((preset) => preset.id === currentPresetId)
      ? currentPresetId
      : fallbackPresetId;
  }

  private requireSession(sessionId: string): AdapterSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams({ sessionId });
    }
    return session;
  }

  private async loadConfigRequirements(): Promise<{
    allowedApprovalPolicies: ApprovalPolicy[];
    allowedSandboxModes: SandboxMode[];
  }> {
    const raw = await this.codex.request('configRequirements/read', undefined);
    const parsed = configRequirementsReadResponseSchema.parse(raw);
    const requirements = parsed.requirements;
    const allowedApprovalPolicies = dedupeStrings(
      (requirements?.allowedApprovalPolicies ?? []).filter(isNonEmptyString)
    );
    const allowedSandboxModes = dedupeStrings(
      (requirements?.allowedSandboxModes ?? []).filter(
        (mode): mode is SandboxMode =>
          mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access'
      )
    );
    const hasExplicitApprovalPolicies = Array.isArray(requirements?.allowedApprovalPolicies);
    const hasExplicitSandboxModes = Array.isArray(requirements?.allowedSandboxModes);

    return {
      allowedApprovalPolicies:
        allowedApprovalPolicies.length > 0
          ? allowedApprovalPolicies
          : hasExplicitApprovalPolicies
            ? []
            : DEFAULT_APPROVAL_POLICIES,
      allowedSandboxModes:
        allowedSandboxModes.length > 0
          ? allowedSandboxModes
          : hasExplicitSandboxModes
            ? []
            : DEFAULT_SANDBOX_MODES,
    };
  }

  private async loadCollaborationModes(): Promise<CollaborationModeEntry[]> {
    const entries: CollaborationModeEntry[] = [];
    let cursor: string | null = null;

    for (;;) {
      const response = await this.requestCollaborationModeListWithRetry(cursor);
      entries.push(
        ...response.data.flatMap((entry) =>
          isNonEmptyString(entry.mode)
            ? [
                {
                  mode: entry.mode,
                  name: entry.name,
                  model: entry.model ?? null,
                  reasoningEffort: entry.reasoning_effort ?? null,
                  developerInstructions: entry.developer_instructions ?? null,
                },
              ]
            : []
        )
      );

      cursor = response.nextCursor ?? null;
      if (!cursor) {
        break;
      }
    }

    if (entries.length === 0) {
      throw new Error('Codex collaborationMode/list returned no modes');
    }
    return entries;
  }

  private async requestCollaborationModeListWithRetry(
    cursor?: string | null,
    maxAttempts = 3
  ): Promise<ReturnType<typeof collaborationModeListResponseSchema.parse>> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const raw = await this.codex.request('collaborationMode/list', cursor ? { cursor } : {});
        return collaborationModeListResponseSchema.parse(raw);
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof CodexRequestError) ||
          error.code !== -32_001 ||
          attempt >= maxAttempts
        ) {
          throw error;
        }

        const delayMs = Math.round(2 ** attempt * 100 + Math.random() * 120);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }

  private async loadModelCatalog(): Promise<CodexModelEntry[]> {
    const models: CodexModelEntry[] = [];
    let cursor: string | null = null;

    for (;;) {
      const response = await this.requestModelListWithRetry(cursor);
      models.push(
        ...response.data.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          description: model.description,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: (model.supportedReasoningEfforts ?? [])
            .filter((entry) => isNonEmptyString(entry.reasoningEffort))
            .map((entry) => ({
              reasoningEffort: entry.reasoningEffort,
              description: entry.description,
            })),
          inputModalities: model.inputModalities ?? [],
          isDefault: model.isDefault ?? false,
        }))
      );

      cursor = response.nextCursor ?? null;
      if (!cursor) {
        return models;
      }
    }
  }

  private async requestModelListWithRetry(
    cursor?: string | null,
    maxAttempts = 3
  ): Promise<ReturnType<typeof modelListResponseSchema.parse>> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const raw = await this.codex.request('model/list', cursor ? { cursor } : {});
        return modelListResponseSchema.parse(raw);
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof CodexRequestError) ||
          error.code !== -32_001 ||
          attempt >= maxAttempts
        ) {
          throw error;
        }

        const delayMs = Math.round(2 ** attempt * 100 + Math.random() * 120);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }

  private async replayThreadHistory(sessionId: string, threadId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const threadReadRaw = await this.codex.request('thread/read', {
      threadId,
      includeTurns: true,
    });
    const threadRead = threadReadResponseSchema.parse(threadReadRaw);

    for (const turn of threadRead.thread.turns) {
      for (const item of turn.items) {
        await this.replayThreadHistoryItem(session, sessionId, turn.id, item);
      }
    }
  }

  private async replayThreadHistoryItem(
    session: AdapterSession,
    sessionId: string,
    turnId: string,
    item: ThreadReadItem
  ): Promise<void> {
    if (item.type === 'userMessage') {
      await this.replayUserMessageHistoryItem(sessionId, item as Record<string, unknown>);
      return;
    }

    if (item.type === 'agentMessage') {
      await this.replayAgentMessageHistoryItem(sessionId, item as Record<string, unknown>);
      return;
    }

    await this.replayToolLikeHistoryItem(session, sessionId, turnId, item);
  }

  private async replayUserMessageHistoryItem(
    sessionId: string,
    item: Record<string, unknown>
  ): Promise<void> {
    const contentBlocks = Array.isArray(item.content) ? item.content : [];
    for (const content of contentBlocks) {
      if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') {
        continue;
      }
      await this.emitSessionUpdate(sessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: content.text },
      });
    }
  }

  private async replayAgentMessageHistoryItem(
    sessionId: string,
    item: Record<string, unknown>
  ): Promise<void> {
    const text = asString(item.text);
    if (!text) {
      return;
    }

    await this.emitSessionUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
  }

  private async replayToolLikeHistoryItem(
    session: AdapterSession,
    sessionId: string,
    turnId: string,
    item: { type: string; id: string } & Record<string, unknown>
  ): Promise<void> {
    if (item.type === 'reasoning') {
      await this.emitReasoningThoughtChunkFromItem(sessionId, item);
      return;
    }

    const toolInfo = this.buildToolCallState(session, item, turnId);
    if (!toolInfo) {
      return;
    }

    await this.emitSessionUpdate(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: toolInfo.toolCallId,
      title: toolInfo.title,
      kind: toolInfo.kind,
      status: 'completed',
      rawInput: item,
      rawOutput: item,
    });
  }

  private async handleCodexNotification(method: string, params: unknown): Promise<void> {
    const parsed = knownCodexNotificationSchema.safeParse({ method, params });
    if (!parsed.success) {
      process.stderr.write(`[codex-app-server-acp] dropped malformed notification: ${method}\n`);
      return;
    }

    const notification = parsed.data;
    if (notification.method === 'error' || notification.method === 'turn/started') {
      return;
    }

    const sessionId = this.sessionIdByThreadId.get(notification.params.threadId);
    if (!sessionId) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (notification.method === 'item/agentMessage/delta') {
      await this.emitSessionUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: notification.params.delta,
        },
      });
      return;
    }

    if (notification.method === 'item/plan/delta') {
      await this.handlePlanDelta(
        sessionId,
        session,
        notification.params.itemId,
        notification.params.delta
      );
      return;
    }

    if (notification.method === 'item/reasoning/summaryTextDelta') {
      await this.emitReasoningThoughtDelta(
        sessionId,
        session,
        notification.params.itemId,
        notification.params.delta
      );
      return;
    }

    if (notification.method === 'item/commandExecution/outputDelta') {
      await this.emitToolCallProgress(
        sessionId,
        session,
        notification.params.itemId,
        notification.params.delta
      );
      return;
    }

    if (notification.method === 'item/fileChange/outputDelta') {
      await this.emitToolCallProgress(
        sessionId,
        session,
        notification.params.itemId,
        notification.params.delta
      );
      return;
    }

    if (notification.method === 'item/mcpToolCall/progress') {
      await this.emitToolCallProgress(
        sessionId,
        session,
        notification.params.itemId,
        notification.params.message
      );
      return;
    }

    if (notification.method === 'item/started') {
      await this.handleItemStarted(
        session,
        notification.params.item as { type: string; id: string } & Record<string, unknown>,
        notification.params.turnId
      );
      return;
    }

    if (notification.method === 'item/completed') {
      await this.handleItemCompleted(
        session,
        notification.params.item as { type: string; id: string } & Record<string, unknown>,
        notification.params.turnId
      );
      return;
    }

    if (notification.method === 'turn/completed') {
      await this.handleTurnCompletedNotification(
        session,
        notification.params.turn.id,
        notification.params.turn.status,
        notification.params.turn.error?.message
      );
    }
  }

  private async handlePlanDelta(
    sessionId: string,
    session: AdapterSession,
    itemId: string,
    delta: string
  ): Promise<void> {
    const previous = session.planTextByItemId.get(itemId) ?? '';
    const next = `${previous}${delta}`;
    session.planTextByItemId.set(itemId, next);

    await this.emitSessionUpdate(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        {
          content: next,
          priority: 'medium',
          status: 'in_progress',
        },
      ],
    });
  }

  private async emitReasoningThoughtChunkFromItem(
    sessionId: string,
    item: Record<string, unknown>
  ): Promise<void> {
    const text = extractReasoningTextLocal(item);
    if (!text) {
      return;
    }

    await this.emitSessionUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
    });
  }

  private async emitReasoningThoughtDelta(
    sessionId: string,
    session: AdapterSession,
    itemId: string,
    delta: string
  ): Promise<void> {
    if (delta.length === 0) {
      return;
    }

    session.reasoningDeltaItemIds.add(itemId);
    await this.emitSessionUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: delta },
    });
  }

  private async emitToolCallProgress(
    sessionId: string,
    session: AdapterSession,
    itemId: string,
    output: string
  ): Promise<void> {
    const toolCall = session.toolCallsByItemId.get(itemId);
    if (!toolCall) {
      return;
    }

    await this.emitSessionUpdate(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: toolCall.toolCallId,
      status: 'in_progress',
      ...(toolCall.locations.length > 0 ? { locations: toolCall.locations } : {}),
      rawOutput: output,
    });
  }

  private async handleTurnCompletedNotification(
    session: AdapterSession,
    turnId: string,
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress',
    errorMessage?: string
  ): Promise<void> {
    if (status === 'inProgress') {
      return;
    }

    const completionStatus = status;
    if (this.shouldDeferTurnCompletion(session, turnId, completionStatus)) {
      session.pendingTurnCompletionsByTurnId.set(
        turnId,
        this.buildPendingTurnCompletion(completionStatus, errorMessage)
      );
      return;
    }

    await this.finalizeTurnCompletion(session, completionStatus, errorMessage);
  }

  private shouldDeferTurnCompletion(
    session: AdapterSession,
    turnId: string,
    status: 'completed' | 'interrupted' | 'failed'
  ): boolean {
    if (!session.activeTurn || session.activeTurn.turnId !== turnId) {
      return true;
    }
    return status !== 'interrupted' && this.hasPendingPlanApprovals(session, turnId);
  }

  private buildPendingTurnCompletion(
    status: 'completed' | 'interrupted' | 'failed',
    errorMessage?: string
  ): PendingTurnCompletion {
    const stopReason = status === 'interrupted' ? 'cancelled' : 'end_turn';
    if (status === 'failed' && errorMessage) {
      return { stopReason, errorMessage };
    }
    return { stopReason };
  }

  private async finalizeTurnCompletion(
    session: AdapterSession,
    status: 'completed' | 'interrupted' | 'failed',
    errorMessage?: string
  ): Promise<void> {
    if (status === 'interrupted') {
      this.settleTurn(session, 'cancelled');
      return;
    }

    if (status === 'failed' && errorMessage) {
      await this.emitTurnFailureMessage(session.sessionId, errorMessage);
    }

    if (status === 'failed') {
      this.settleTurn(session, 'end_turn');
      return;
    }

    this.settleTurn(session, session.activeTurn?.cancelRequested ? 'cancelled' : 'end_turn');
  }

  private async handleItemStarted(
    session: AdapterSession,
    item: { type: string; id: string } & Record<string, unknown>,
    turnId: string
  ): Promise<void> {
    if (item.type === 'reasoning') {
      // Reasoning text is emitted from deltas and/or completion fallback.
      // Skipping started-item text avoids duplicate thought chunks when a started
      // payload includes summary text and deltas arrive afterward.
      return;
    }

    const toolInfo = this.buildToolCallState(session, item, turnId);
    if (!toolInfo) {
      return;
    }

    session.toolCallsByItemId.set(item.id, toolInfo);

    await this.emitSessionUpdate(session.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: toolInfo.toolCallId,
      title: toolInfo.title,
      kind: toolInfo.kind,
      status: 'pending',
      ...(toolInfo.locations.length > 0 ? { locations: toolInfo.locations } : {}),
      rawInput: item,
    });

    const itemStatus = toToolStatus(item.status);
    if (itemStatus === 'in_progress') {
      await this.emitSessionUpdate(session.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: toolInfo.toolCallId,
        status: 'in_progress',
      });
    }
  }

  private async handleItemCompleted(
    session: AdapterSession,
    item: { type: string; id: string } & Record<string, unknown>,
    turnId: string
  ): Promise<void> {
    if (item.type === 'reasoning') {
      const sawDelta = session.reasoningDeltaItemIds.has(item.id);
      session.reasoningDeltaItemIds.delete(item.id);
      if (!sawDelta) {
        await this.emitReasoningThoughtChunkFromItem(session.sessionId, item);
      }
      return;
    }

    const existing = session.toolCallsByItemId.get(item.id);
    if (!existing) {
      return;
    }

    const shouldHoldTurnForPlanApproval =
      item.type === 'plan' &&
      isPlanLikeMode(session.defaults.collaborationMode) &&
      !session.planApprovalRequestedByTurnId.has(turnId) &&
      this.extractPlanApprovalText(session, item) !== null;
    if (shouldHoldTurnForPlanApproval) {
      this.holdTurnUntilPlanApprovalResolves(session, turnId);
    }

    const statusFromItem = toToolStatus(item.status);
    const status = statusFromItem ?? 'completed';
    const completionLocations = this.extractLocations(item);
    const locations = dedupeLocations([...existing.locations, ...completionLocations]);

    await this.emitSessionUpdate(session.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: existing.toolCallId,
      status,
      kind: existing.kind,
      title: existing.title,
      ...(locations.length > 0 ? { locations } : {}),
      rawOutput: item,
    });

    session.toolCallsByItemId.delete(item.id);

    await this.maybeRequestPlanApproval(session, item, turnId, existing);
  }

  private buildPlanApprovalInput(planText: string, sourceItemId: string): Record<string, unknown> {
    return {
      type: 'ExitPlanMode',
      plan: { type: 'text', text: planText },
      reason: 'Plan proposed. Approve to exit plan mode and continue implementation.',
      source: 'codex_plan_completion',
      sourceItemId,
    };
  }

  private extractPlanApprovalText(
    session: AdapterSession,
    item: { id: string } & Record<string, unknown>
  ): string | null {
    const bufferedText = session.planTextByItemId.get(item.id);
    if (bufferedText && bufferedText.trim().length > 0) {
      return bufferedText;
    }
    const fromPlanField = extractPlanTextLocal(item.plan);
    if (fromPlanField && fromPlanField.trim().length > 0) {
      return fromPlanField;
    }
    const fromTextField = extractPlanTextLocal(item.text);
    if (fromTextField && fromTextField.trim().length > 0) {
      return fromTextField;
    }
    return null;
  }

  private getPlanExitModePriority(modeId: string): number {
    const normalized = modeId.toLowerCase();
    const index = PLAN_EXIT_MODE_PREFERENCE.findIndex(
      (preferred) => preferred.toLowerCase() === normalized
    );
    return index >= 0 ? index : PLAN_EXIT_MODE_PREFERENCE.length;
  }

  private comparePlanExitModePreference(left: string, right: string): number {
    const priorityDiff = this.getPlanExitModePriority(left) - this.getPlanExitModePriority(right);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return left.localeCompare(right);
  }

  private resolveCollaborationModeLabel(modeId: string): string {
    const entry = this.collaborationModes.find((candidate) => candidate.mode === modeId);
    if (entry?.name) {
      return entry.name;
    }
    return sanitizeModeName(modeId);
  }

  private buildPlanApprovalOptions(session: AdapterSession): {
    options: Array<{
      optionId: string;
      name: string;
      kind: 'allow_once' | 'reject_once';
    }>;
    approvableModeIds: Set<string>;
  } {
    const currentMode = session.defaults.collaborationMode;
    const availableModes = this.getCollaborationModeValues(currentMode);
    const nonPlanModes = availableModes
      .filter((modeId) => !isPlanLikeMode(modeId))
      .sort((left, right) => this.comparePlanExitModePreference(left, right));

    const approvableModeIds = new Set<string>(nonPlanModes);
    const options: Array<{ optionId: string; name: string; kind: 'allow_once' | 'reject_once' }> =
      nonPlanModes.map((modeId) => ({
        optionId: modeId,
        name: `Approve and switch to ${this.resolveCollaborationModeLabel(modeId)}`,
        kind: 'allow_once' as const,
      }));

    options.push({
      optionId: currentMode,
      name: 'Keep planning',
      kind: 'reject_once',
    });

    return { options, approvableModeIds };
  }

  private holdTurnUntilPlanApprovalResolves(session: AdapterSession, turnId: string): void {
    if (this.hasPendingPlanApprovals(session, turnId)) {
      return;
    }
    session.pendingPlanApprovalsByTurnId.set(turnId, 1);
  }

  private hasPendingPlanApprovals(session: AdapterSession, turnId: string): boolean {
    return (session.pendingPlanApprovalsByTurnId.get(turnId) ?? 0) > 0;
  }

  private async releaseTurnHoldForPlanApproval(
    session: AdapterSession,
    turnId: string
  ): Promise<void> {
    const pendingCount = session.pendingPlanApprovalsByTurnId.get(turnId) ?? 0;
    if (pendingCount <= 1) {
      session.pendingPlanApprovalsByTurnId.delete(turnId);
    } else {
      session.pendingPlanApprovalsByTurnId.set(turnId, pendingCount - 1);
    }

    if (this.hasPendingPlanApprovals(session, turnId)) {
      return;
    }

    if (!session.activeTurn || session.activeTurn.settled || session.activeTurn.turnId !== turnId) {
      return;
    }

    const deferredCompletion = session.pendingTurnCompletionsByTurnId.get(turnId);
    if (!deferredCompletion) {
      return;
    }

    session.pendingTurnCompletionsByTurnId.delete(turnId);
    if (deferredCompletion.errorMessage) {
      await this.emitTurnFailureMessage(session.sessionId, deferredCompletion.errorMessage);
    }
    this.settleTurn(session, deferredCompletion.stopReason);
  }

  private async maybeRequestPlanApproval(
    session: AdapterSession,
    item: { type: string; id: string } & Record<string, unknown>,
    turnId: string,
    completedPlanToolCall: ToolCallState
  ): Promise<void> {
    if (item.type !== 'plan') {
      return;
    }
    if (!isPlanLikeMode(session.defaults.collaborationMode)) {
      return;
    }
    if (session.planApprovalRequestedByTurnId.has(turnId)) {
      return;
    }

    const planText = this.extractPlanApprovalText(session, item);
    if (!planText) {
      return;
    }

    session.planApprovalRequestedByTurnId.add(turnId);
    this.holdTurnUntilPlanApprovalResolves(session, turnId);
    const approvalToolCallId = `${completedPlanToolCall.toolCallId}:exit-plan`;
    const approvalInput = this.buildPlanApprovalInput(planText, item.id);

    await this.emitSessionUpdate(session.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: approvalToolCallId,
      title: 'ExitPlanMode',
      kind: 'switch_mode',
      status: 'pending',
      rawInput: approvalInput,
    });

    try {
      const { options: planApprovalOptions, approvableModeIds } =
        this.buildPlanApprovalOptions(session);
      if (approvableModeIds.size === 0) {
        await this.emitSessionUpdate(session.sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: approvalToolCallId,
          kind: 'switch_mode',
          title: 'ExitPlanMode',
          status: 'failed',
          rawOutput: 'Plan proposed, but no non-plan collaboration mode is available.',
        });
        return;
      }

      const permissionResult = await this.connection.requestPermission({
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: approvalToolCallId,
          title: 'ExitPlanMode',
          kind: 'switch_mode',
          status: 'pending',
          rawInput: approvalInput,
        },
        options: planApprovalOptions,
      });

      const selectedMode =
        permissionResult.outcome.outcome === 'selected' &&
        approvableModeIds.has(permissionResult.outcome.optionId)
          ? permissionResult.outcome.optionId
          : null;
      const approved = selectedMode !== null;

      if (selectedMode && session.defaults.collaborationMode !== selectedMode) {
        session.defaults.collaborationMode = selectedMode;
        await this.emitSessionUpdate(session.sessionId, {
          sessionUpdate: 'config_option_update',
          configOptions: this.buildConfigOptions(session),
        });
      }

      await this.emitSessionUpdate(session.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: approvalToolCallId,
        kind: 'switch_mode',
        title: 'ExitPlanMode',
        status: approved ? 'completed' : 'failed',
        rawOutput: approved ? 'Plan approved' : 'Plan approval rejected',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.emitSessionUpdate(session.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: approvalToolCallId,
        kind: 'switch_mode',
        title: 'ExitPlanMode',
        status: 'failed',
        rawOutput: `Plan approval failed: ${message}`,
      });
    } finally {
      await this.releaseTurnHoldForPlanApproval(session, turnId);
    }
  }

  private extractLocations(item: unknown): Array<{ path: string; line?: number | null }> {
    if (!isRecord(item) || item.type !== 'fileChange') {
      return [];
    }

    const changes = item.changes;
    if (!Array.isArray(changes)) {
      return [];
    }

    const locations: Array<{ path: string }> = [];
    for (const change of changes) {
      if (!isRecord(change)) {
        continue;
      }
      const path = asString(change.path);
      if (!path) {
        continue;
      }
      locations.push({ path });
    }

    return locations;
  }

  private buildToolCallState(
    session: AdapterSession,
    item: { type: string; id: string } & Record<string, unknown>,
    _turnId: string
  ): ToolCallState | null {
    const kindByType: Record<string, ToolCallState['kind']> = {
      commandExecution: 'execute',
      fileChange: 'edit',
      mcpToolCall: 'fetch',
      webSearch: 'search',
      plan: 'think',
    };

    const kind = kindByType[item.type];
    if (!kind) {
      return null;
    }

    let title = item.type;
    let kindToEmit = kind;
    let locations: Array<{ path: string; line?: number | null }> = [];
    if (item.type === 'commandExecution') {
      const command = asString(item.command);
      const cwd = asString(item.cwd) ?? session.cwd;
      const parsed = resolveCommandDisplay({ command, cwd });
      title = parsed.title;
      kindToEmit = parsed.kind;
      locations = parsed.locations;
    } else if (item.type === 'fileChange') {
      title = 'fileChange';
      locations = this.extractLocations(item);
    } else if (item.type === 'mcpToolCall') {
      const server = asString(item.server) ?? 'mcp';
      const tool = asString(item.tool) ?? 'tool';
      title = `mcpToolCall:${server}/${tool}`;
    } else if (item.type === 'webSearch') {
      const query = asString(item.query);
      title = query ? `webSearch:${query}` : 'webSearch';
    }

    return {
      toolCallId: resolveToolCallId({
        itemId: item.id,
        source: item,
      }),
      kind: kindToEmit,
      title,
      locations,
    };
  }

  private buildPermissionOptions(params: {
    method:
      | 'item/commandExecution/requestApproval'
      | 'item/fileChange/requestApproval'
      | 'item/tool/requestUserInput';
    questions: ToolUserInputQuestion[];
  }): Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once';
  }> {
    if (params.method === 'item/tool/requestUserInput') {
      return buildToolUserInputPermissionOptions(params.questions);
    }
    if (params.method === 'item/commandExecution/requestApproval') {
      return [
        {
          optionId: 'allow_always',
          name: 'Allow for session',
          kind: 'allow_always',
        },
        {
          optionId: 'allow_once',
          name: 'Allow once',
          kind: 'allow_once',
        },
        {
          optionId: 'reject_once',
          name: 'Reject',
          kind: 'reject_once',
        },
      ];
    }
    return [
      {
        optionId: 'allow_once',
        name: 'Allow once',
        kind: 'allow_once',
      },
      {
        optionId: 'reject_once',
        name: 'Reject',
        kind: 'reject_once',
      },
    ];
  }

  private async maybeAutoApproveCommandRequest(params: {
    request: ReturnType<typeof knownCodexServerRequestSchema.parse>;
    session: AdapterSession;
    toolCallId: string;
  }): Promise<boolean> {
    if (
      params.request.method !== 'item/commandExecution/requestApproval' ||
      !params.session.commandApprovalAlways
    ) {
      return false;
    }
    await this.respondToCodexPermissionRequest({
      request: params.request,
      permission: {
        outcome: { outcome: 'selected', optionId: 'allow_always' },
      },
      session: params.session,
      toolCallId: params.toolCallId,
      questions: [],
    });
    return true;
  }

  private async handleCodexServerRequest(request: {
    id: string | number | null;
    method: string;
    params?: unknown;
  }): Promise<void> {
    try {
      const parsed = knownCodexServerRequestSchema.safeParse(request);
      if (!parsed.success) {
        this.codex.respondError(request.id, {
          code: -32_602,
          message: 'Unsupported codex server request payload',
        });
        return;
      }

      const typed = parsed.data;
      const sessionId = this.sessionIdByThreadId.get(typed.params.threadId);
      if (!sessionId) {
        this.codex.respondError(typed.id, {
          code: -32_603,
          message: 'No ACP session mapped for this thread',
        });
        return;
      }

      const session = this.sessions.get(sessionId);
      if (!session) {
        this.codex.respondError(typed.id, {
          code: -32_603,
          message: 'No ACP session mapped for this thread',
        });
        return;
      }

      const existingTool = session.toolCallsByItemId.get(typed.params.itemId);
      const toolCall =
        existingTool ??
        this.buildApprovalToolCallState(
          session,
          typed.method,
          typed.params.itemId,
          typed.params.turnId,
          typed.params
        );
      session.toolCallsByItemId.set(typed.params.itemId, toolCall);

      if (!existingTool) {
        await this.emitSessionUpdate(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: toolCall.toolCallId,
          title: toolCall.title,
          kind: toolCall.kind,
          status: 'pending',
          ...(toolCall.locations.length > 0 ? { locations: toolCall.locations } : {}),
          rawInput: typed.params,
        });
      }

      if (
        await this.maybeAutoApproveCommandRequest({
          request: typed,
          session,
          toolCallId: toolCall.toolCallId,
        })
      ) {
        return;
      }

      const questions = typed.method === 'item/tool/requestUserInput' ? typed.params.questions : [];
      const permissionOptions = this.buildPermissionOptions({
        method: typed.method,
        questions,
      });

      const permissionResult = await this.connection.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: toolCall.toolCallId,
          title: toolCall.title,
          kind: toolCall.kind,
          status: 'pending',
          rawInput: typed.params,
        },
        options: permissionOptions,
      });

      await this.respondToCodexPermissionRequest({
        request: typed,
        permission: permissionResult,
        session,
        toolCallId: toolCall.toolCallId,
        questions,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.codex.respondError(request.id, {
        code: -32_600,
        message: 'Failed to process codex approval request',
        data: { error: message },
      });
    }
  }

  private buildApprovalToolCallState(
    session: AdapterSession,
    method:
      | 'item/commandExecution/requestApproval'
      | 'item/fileChange/requestApproval'
      | 'item/tool/requestUserInput',
    itemId: string,
    _turnId: string,
    params: Record<string, unknown>
  ): ToolCallState {
    if (method === 'item/commandExecution/requestApproval') {
      const command = asString(params.command);
      const cwd = asString(params.cwd) ?? session.cwd;
      const parsed = resolveCommandDisplay({ command, cwd });
      return {
        toolCallId: resolveToolCallId({
          itemId,
          source: params,
        }),
        title: parsed.title,
        kind: parsed.kind,
        locations: parsed.locations,
      };
    }

    if (method === 'item/fileChange/requestApproval') {
      const grantRoot = asString(params.grantRoot);
      return {
        toolCallId: resolveToolCallId({
          itemId,
          source: params,
        }),
        title: 'fileChange',
        kind: 'edit',
        locations: grantRoot ? [{ path: grantRoot }] : [],
      };
    }

    return {
      toolCallId: resolveToolCallId({
        itemId,
        source: params,
      }),
      title: 'item/tool/requestUserInput',
      kind: 'other',
      locations: [],
    };
  }

  private isAllowedPermissionSelection(selectedOptionId: string | null): boolean {
    return selectedOptionId === 'allow_once' || selectedOptionId === 'allow_always';
  }

  private async handleToolUserInputPermissionResponse(params: {
    request: ReturnType<typeof knownCodexServerRequestSchema.parse>;
    permission: RequestPermissionResponse;
    session: AdapterSession;
    toolCallId: string;
    questions: ToolUserInputQuestion[];
    selectedOptionId: string | null;
  }): Promise<boolean> {
    if (params.request.method !== 'item/tool/requestUserInput') {
      return false;
    }

    const rejected = params.selectedOptionId === null || params.selectedOptionId === 'reject_once';
    let answers: UserInputAnswers;
    try {
      answers = buildToolUserInputAnswers({
        questions: params.questions,
        permission: params.permission,
        selectedOptionId: params.selectedOptionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.codex.respondError(params.request.id, {
        code: -32_602,
        message: 'Failed to map requestUserInput answers',
        data: { error: message },
      });
      await this.emitSessionUpdate(params.session.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: params.toolCallId,
        status: 'failed',
        rawOutput: { error: message },
      });
      return true;
    }

    this.codex.respondSuccess(params.request.id, {
      answers,
    });

    await this.emitSessionUpdate(params.session.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: rejected ? 'failed' : 'completed',
      rawOutput: rejected ? { outcome: 'rejected' } : { answers },
    });
    return true;
  }

  private async respondToCodexPermissionRequest(params: {
    request: ReturnType<typeof knownCodexServerRequestSchema.parse>;
    permission: RequestPermissionResponse;
    session: AdapterSession;
    toolCallId: string;
    questions: ToolUserInputQuestion[];
  }): Promise<void> {
    const selected =
      params.permission.outcome.outcome === 'selected' ? params.permission.outcome.optionId : null;
    if (
      await this.handleToolUserInputPermissionResponse({
        ...params,
        selectedOptionId: selected,
      })
    ) {
      return;
    }

    if (
      params.request.method === 'item/commandExecution/requestApproval' &&
      selected === 'allow_always'
    ) {
      params.session.commandApprovalAlways = true;
    }
    const allow = this.isAllowedPermissionSelection(selected);

    this.codex.respondSuccess(params.request.id, {
      decision: allow ? 'accept' : 'decline',
    });

    await this.emitSessionUpdate(params.session.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: allow ? 'in_progress' : 'failed',
      rawOutput: { decision: allow ? 'accept' : 'decline' },
    });
  }

  private settleTurn(session: AdapterSession, stopReason: StopReason): void {
    if (!session.activeTurn || session.activeTurn.settled) {
      return;
    }

    session.activeTurn.settled = true;
    session.activeTurn.resolve(stopReason);
    session.activeTurn = null;
    session.planTextByItemId.clear();
    session.planApprovalRequestedByTurnId.clear();
    session.pendingPlanApprovalsByTurnId.clear();
    session.toolCallsByItemId.clear();
    session.reasoningDeltaItemIds.clear();
    session.pendingTurnCompletionsByTurnId.clear();
  }

  private async emitSessionUpdate(sessionId: string, update: SessionUpdate): Promise<void> {
    try {
      await this.connection.sessionUpdate({ sessionId, update });
    } catch {
      // Connection may have been closed by the client. Ignore and keep adapter alive.
    }
  }
}

export function runCodexAppServerAcpAdapter(): void {
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);
  new AgentSideConnection((connection) => new CodexAppServerAcpAdapter(connection), stream);
}
