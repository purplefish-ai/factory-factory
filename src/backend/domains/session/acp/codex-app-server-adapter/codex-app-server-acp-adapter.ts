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
};

type ActiveTurnState = {
  turnId: string;
  cancelRequested: boolean;
  settled: boolean;
  resolve: (value: StopReason) => void;
};

type PendingTurnCompletion = {
  stopReason: StopReason;
  errorMessage?: string;
};

type ExecutionPreset = {
  id: 'current' | 'full_auto' | 'yolo';
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
  planTextByItemId: Map<string, string>;
  pendingTurnCompletionsByTurnId: Map<string, PendingTurnCompletion>;
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

function sanitizeModeName(mode: string): string {
  return mode
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
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

function createToolCallId(threadId: string, turnId: string, itemId: string): string {
  return `codex:${threadId}:${turnId}:${itemId}`;
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
  selectedOptionId: string | null;
}): UserInputAnswers {
  if (params.selectedOptionId === null || params.selectedOptionId === 'reject_once') {
    return {};
  }

  const parsedAnswers = parseSerializedToolUserInputAnswers({
    questions: params.questions,
    selectedOptionId: params.selectedOptionId,
  });
  if (parsedAnswers) {
    return parsedAnswers;
  }

  const selectedIndex = params.selectedOptionId.startsWith('answer_')
    ? Number.parseInt(params.selectedOptionId.slice('answer_'.length), 10)
    : Number.NaN;

  const answers: UserInputAnswers = {};
  for (const question of params.questions) {
    if (!Array.isArray(question.options) || question.options.length === 0) {
      continue;
    }
    const selectedOption = Number.isNaN(selectedIndex)
      ? question.options[0]
      : (question.options[selectedIndex] ?? question.options[0]);
    if (!selectedOption) {
      continue;
    }
    answers[question.id] = { answers: [selectedOption.label] };
  }
  return answers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TOOL_USER_INPUT_ANSWERS_PREFIX = 'answers_json_v1:';

function parseSerializedToolUserInputAnswers(params: {
  questions: ToolUserInputQuestion[];
  selectedOptionId: string;
}): UserInputAnswers | null {
  if (!params.selectedOptionId.startsWith(TOOL_USER_INPUT_ANSWERS_PREFIX)) {
    return null;
  }

  const encodedPayload = params.selectedOptionId.slice(TOOL_USER_INPUT_ANSWERS_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(encodedPayload));
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const knownQuestionIds = new Set(params.questions.map((question) => question.id));
  const answers: UserInputAnswers = {};
  for (const [questionId, value] of Object.entries(parsed)) {
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

export class CodexAppServerAcpAdapter implements Agent {
  private readonly connection: AgentSideConnection;
  private readonly codex: CodexClient;
  private readonly sessions = new Map<string, AdapterSession>();
  private readonly sessionIdByThreadId = new Map<string, string>();
  private modelCatalog: CodexModelEntry[] = [];
  private allowedApprovalPolicies: ApprovalPolicy[] = [];
  private allowedSandboxModes: SandboxMode[] = [];
  private collaborationModes: CollaborationModeEntry[] = [];

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
          void this.handleCodexServerRequest(request);
        },
        onProtocolError: (error) => {
          process.stderr.write(`[codex-app-server-acp] protocol-error: ${error.reason}\n`);
        },
      });

    // AgentSideConnection initializes its internal connection after invoking toAgent().
    // Defer closed-hook registration to avoid accessing connection internals too early.
    queueMicrotask(() => {
      void this.connection.closed.finally(async () => {
        await this.codex.stop();
      });
    });
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
      planTextByItemId: new Map(),
      pendingTurnCompletionsByTurnId: new Map(),
    };

    this.sessions.set(sessionId, session);
    this.sessionIdByThreadId.set(session.threadId, sessionId);
    try {
      await this.applyMcpServers(params.mcpServers);
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
      planTextByItemId: new Map(),
      pendingTurnCompletionsByTurnId: new Map(),
    };

    this.sessions.set(session.sessionId, session);
    this.sessionIdByThreadId.set(session.threadId, session.sessionId);
    try {
      await this.applyMcpServers(params.mcpServers);
      await this.replayThreadHistory(session.sessionId, session.threadId);
    } catch (error) {
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
      .map((text) => ({ type: 'text', text, text_elements: [] as [] }));

    const safeInput =
      input.length > 0 ? input : [{ type: 'text', text: '', text_elements: [] as [] }];

    try {
      const turnStartParams: Record<string, unknown> = {
        threadId: session.threadId,
        input: safeInput,
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
      const immediateStopReason = await this.resolveImmediateTurnStopReason(session, turnStart);
      if (immediateStopReason) {
        return { stopReason: immediateStopReason };
      }
      const stopReason = await this.waitForTurnCompletion(session, turnStart.turn.id);

      return { stopReason };
    } catch (error) {
      if (error instanceof CodexRequestError && error.code === -32_001) {
        await this.emitSessionUpdate(session.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Codex app-server is overloaded. Please retry shortly.',
          },
        });
        session.activeTurn = null;
        return { stopReason: 'end_turn' };
      }

      session.activeTurn = null;
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

  private async waitForTurnCompletion(
    session: AdapterSession,
    turnId: string
  ): Promise<StopReason> {
    const stopReasonPromise = new Promise<StopReason>((resolve) => {
      session.activeTurn = {
        turnId,
        cancelRequested: false,
        settled: false,
        resolve,
      };
    });

    const pendingCompletion = session.pendingTurnCompletionsByTurnId.get(turnId);
    if (pendingCompletion) {
      session.pendingTurnCompletionsByTurnId.delete(turnId);
      if (pendingCompletion.errorMessage) {
        await this.emitTurnFailureMessage(session.sessionId, pendingCompletion.errorMessage);
      }
      this.settleTurn(session, pendingCompletion.stopReason);
    }

    return await stopReasonPromise;
  }

  private async emitTurnFailureMessage(sessionId: string, errorMessage: string): Promise<void> {
    await this.emitSessionUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: `Turn failed: ${errorMessage}`,
      },
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session?.activeTurn) {
      return;
    }

    session.activeTurn.cancelRequested = true;

    try {
      await this.codex.request('turn/interrupt', {
        threadId: session.threadId,
        turnId: session.activeTurn.turnId,
      });
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

  private async applyMcpServers(mcpServers: McpServer[]): Promise<void> {
    if (mcpServers.length === 0) {
      return;
    }

    const codexMcpServers = toCodexMcpConfigMap(mcpServers);
    await this.codex.request('config/value/write', {
      keyPath: 'mcp_servers',
      value: codexMcpServers,
      mergeStrategy: 'replace',
    });
    await this.codex.request('config/mcpServer/reload', {});
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
    const preferredDefault = this.collaborationModes.find((entry) => entry.mode === 'default');
    return preferredDefault?.mode ?? this.collaborationModes[0]?.mode ?? 'default';
  }

  private resolveTurnCollaborationMode(session: AdapterSession): Record<string, unknown> | null {
    if (session.defaults.collaborationMode === 'default') {
      return null;
    }

    const modeEntry = this.collaborationModes.find(
      (entry) => entry.mode === session.defaults.collaborationMode
    );
    if (!modeEntry) {
      return null;
    }

    return {
      mode: modeEntry.mode,
      settings: {
        model: modeEntry.model ?? session.defaults.model,
        reasoning_effort: modeEntry.reasoningEffort ?? session.defaults.reasoningEffort,
        developer_instructions: modeEntry.developerInstructions,
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

  private isApprovalPolicyAllowed(policy: ApprovalPolicy): boolean {
    return (
      this.allowedApprovalPolicies.length === 0 || this.allowedApprovalPolicies.includes(policy)
    );
  }

  private isSandboxModeAllowed(mode: SandboxMode): boolean {
    return this.allowedSandboxModes.length === 0 || this.allowedSandboxModes.includes(mode);
  }

  private getExecutionPresets(session: AdapterSession): ExecutionPreset[] {
    const currentSandboxMode =
      parseSandboxModeFromPolicy(session.defaults.sandboxPolicy) ?? 'workspace-write';
    const presets: ExecutionPreset[] = [
      {
        id: 'current',
        name: 'Current',
        description: `${session.defaults.approvalPolicy} + ${currentSandboxMode}`,
        approvalPolicy: session.defaults.approvalPolicy,
        sandboxMode: currentSandboxMode,
      },
    ];

    if (
      this.isApprovalPolicyAllowed('on-request') &&
      this.isSandboxModeAllowed('workspace-write')
    ) {
      presets.push({
        id: 'full_auto',
        name: 'Full Auto',
        description: 'on-request + workspace-write',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
      });
    }

    if (this.isApprovalPolicyAllowed('never') && this.isSandboxModeAllowed('danger-full-access')) {
      presets.push({
        id: 'yolo',
        name: 'YOLO',
        description: 'never + danger-full-access',
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      });
    }

    return presets;
  }

  private resolveExecutionPresetId(
    session: AdapterSession,
    presets: ExecutionPreset[]
  ): ExecutionPreset['id'] {
    const currentSandboxMode = parseSandboxModeFromPolicy(session.defaults.sandboxPolicy);
    for (const preset of presets) {
      if (
        preset.id === 'current' ||
        preset.approvalPolicy !== session.defaults.approvalPolicy ||
        preset.sandboxMode !== currentSandboxMode
      ) {
        continue;
      }
      return preset.id;
    }
    return 'current';
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
    const allowedApprovalPolicies = dedupeStrings(
      (parsed.requirements?.allowedApprovalPolicies ?? []).filter(isNonEmptyString)
    );
    const allowedSandboxModes = dedupeStrings(
      (parsed.requirements?.allowedSandboxModes ?? []).filter(
        (mode): mode is SandboxMode =>
          mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access'
      )
    );

    return {
      allowedApprovalPolicies,
      allowedSandboxModes,
    };
  }

  private async loadCollaborationModes(): Promise<CollaborationModeEntry[]> {
    try {
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

      if (entries.length > 0) {
        return entries;
      }
    } catch (error) {
      if (
        !(error instanceof CodexRequestError) ||
        (error.code !== -32_601 && error.code !== -32_600)
      ) {
        throw error;
      }
    }

    return [
      {
        mode: 'default',
        name: 'Default',
        model: null,
        reasoningEffort: null,
        developerInstructions: null,
      },
    ];
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

    const stopReason = status === 'interrupted' ? 'cancelled' : 'end_turn';

    if (!session.activeTurn || session.activeTurn.turnId !== turnId) {
      session.pendingTurnCompletionsByTurnId.set(turnId, {
        stopReason,
        ...(status === 'failed' && errorMessage ? { errorMessage } : {}),
      });
      return;
    }

    if (status === 'interrupted') {
      this.settleTurn(session, 'cancelled');
      return;
    }

    if (status === 'failed') {
      if (errorMessage) {
        await this.emitSessionUpdate(session.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Turn failed: ${errorMessage}`,
          },
        });
      }
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
    _turnId: string
  ): Promise<void> {
    const existing = session.toolCallsByItemId.get(item.id);
    if (!existing) {
      return;
    }

    const statusFromItem = toToolStatus(item.status);
    const status = statusFromItem ?? 'completed';
    const locations = this.extractLocations(item);

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
    turnId: string
  ): ToolCallState | null {
    const kindByType: Record<string, ToolCallState['kind']> = {
      commandExecution: 'execute',
      fileChange: 'edit',
      mcpToolCall: 'fetch',
      webSearch: 'search',
      plan: 'think',
      reasoning: 'think',
    };

    const kind = kindByType[item.type];
    if (!kind) {
      return null;
    }

    let title = item.type;
    if (item.type === 'commandExecution') {
      title = asString(item.command) ? `Run: ${item.command}` : 'Command execution';
    } else if (item.type === 'fileChange') {
      title = 'Apply file changes';
    } else if (item.type === 'mcpToolCall') {
      const server = asString(item.server) ?? 'mcp';
      const tool = asString(item.tool) ?? 'tool';
      title = `MCP: ${server}/${tool}`;
    } else if (item.type === 'webSearch') {
      title = asString(item.query) ? `Web search: ${item.query}` : 'Web search';
    }

    return {
      toolCallId: createToolCallId(session.threadId, turnId, item.id),
      kind,
      title,
    };
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
          rawInput: typed.params,
        });
      }

      const questions = typed.method === 'item/tool/requestUserInput' ? typed.params.questions : [];
      const permissionOptions =
        typed.method === 'item/tool/requestUserInput'
          ? buildToolUserInputPermissionOptions(questions)
          : [
              {
                optionId: 'allow_once',
                name: 'Allow once',
                kind: 'allow_once' as const,
              },
              {
                optionId: 'reject_once',
                name: 'Reject',
                kind: 'reject_once' as const,
              },
            ];

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
    turnId: string,
    params: Record<string, unknown>
  ): ToolCallState {
    if (method === 'item/commandExecution/requestApproval') {
      const command = asString(params.command);
      return {
        toolCallId: createToolCallId(session.threadId, turnId, itemId),
        title: command ? `Run: ${command}` : 'Command execution',
        kind: 'execute',
      };
    }

    if (method === 'item/fileChange/requestApproval') {
      return {
        toolCallId: createToolCallId(session.threadId, turnId, itemId),
        title: 'Apply file changes',
        kind: 'edit',
      };
    }

    return {
      toolCallId: createToolCallId(session.threadId, turnId, itemId),
      title: 'AskUserQuestion',
      kind: 'other',
    };
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
    const allow = selected === 'allow_once';

    if (params.request.method === 'item/tool/requestUserInput') {
      const rejected = selected === null || selected === 'reject_once';
      const answers = buildToolUserInputAnswers({
        questions: params.questions,
        selectedOptionId: selected,
      });

      this.codex.respondSuccess(params.request.id, {
        answers,
      });

      await this.emitSessionUpdate(params.session.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: params.toolCallId,
        status: rejected ? 'failed' : 'completed',
        rawOutput: rejected ? 'User denied tool input request' : { answers },
      });
      return;
    }

    this.codex.respondSuccess(params.request.id, {
      decision: allow ? 'accept' : 'decline',
    });

    await this.emitSessionUpdate(params.session.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: allow ? 'in_progress' : 'failed',
      rawOutput: allow ? 'Approved by user' : 'Declined by user',
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
    session.toolCallsByItemId.clear();
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
