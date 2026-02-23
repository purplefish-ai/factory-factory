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
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
} from '@agentclientprotocol/sdk';
import { asString, dedupeStrings, isRecord, resolveToolCallId } from './acp-adapter-utils';
import type {
  AdapterSession,
  ApprovalPolicy,
  CodexClient,
  CodexMcpServerConfig,
  CodexModelEntry,
  CollaborationModeEntry,
  ExecutionPreset,
  ReasoningEffort,
  SandboxMode,
  ToolCallState,
} from './adapter-state';
import { CodexRequestError, CodexRpcClient } from './codex-rpc-client';
import {
  collaborationModeListResponseSchema,
  configRequirementsReadResponseSchema,
  modelListResponseSchema,
  threadResumeResponseSchema,
  threadStartResponseSchema,
  turnStartResponseSchema,
} from './codex-zod';
import { resolveCommandDisplay } from './command-metadata';
import { handleCodexServerPermissionRequest } from './protocol-permission-handler';
import { CodexStreamEventHandler } from './stream-event-handler';

const PENDING_TURN_ID = '__pending_turn__';
const MAX_CLOSE_WATCHER_ATTACH_RETRIES = 50;
const DEFAULT_APPROVAL_POLICIES: ApprovalPolicy[] = ['on-failure', 'on-request', 'never'];
const DEFAULT_SANDBOX_MODES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const SHAPE_DRIFT_DETAILS_LIMIT = 700;

type PromptContentBlock = PromptRequest['prompt'][number];
type TurnStartResponse = ReturnType<typeof turnStartResponseSchema.parse>;

function toShapeDriftDetails(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') {
      return '[unserializable]';
    }
    return text.length > SHAPE_DRIFT_DETAILS_LIMIT
      ? `${text.slice(0, SHAPE_DRIFT_DETAILS_LIMIT)}...`
      : text;
  } catch {
    return '[unserializable]';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
  private readonly shapeDriftCounts = new Map<string, number>();
  private readonly streamEventHandler: CodexStreamEventHandler;

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

    this.streamEventHandler = new CodexStreamEventHandler({
      codex: this.codex,
      sessionIdByThreadId: this.sessionIdByThreadId,
      sessions: this.sessions,
      requireSession: (sessionId) => this.requireSession(sessionId),
      emitSessionUpdate: (sessionId, update) => this.emitSessionUpdate(sessionId, update),
      reportShapeDrift: (event, details) => this.reportShapeDrift(event, details),
      buildToolCallState: (session, item, turnId) => this.buildToolCallState(session, item, turnId),
      emitReasoningThoughtChunkFromItem: (sessionId, item) =>
        this.emitReasoningThoughtChunkFromItem(sessionId, item),
      shouldHoldTurnForPlanApproval: (session, item, turnId) =>
        this.shouldHoldTurnForPlanApproval(session, item, turnId),
      holdTurnUntilPlanApprovalResolves: (session, turnId) =>
        this.holdTurnUntilPlanApprovalResolves(session, turnId),
      maybeRequestPlanApproval: (session, item, turnId, completedPlanToolCall) =>
        this.maybeRequestPlanApproval(session, item, turnId, completedPlanToolCall),
      hasPendingPlanApprovals: (session, turnId) => this.hasPendingPlanApprovals(session, turnId),
      settleTurn: (session, stopReason) => this.settleTurn(session, stopReason),
      emitTurnFailureMessage: (sessionId, errorMessage) =>
        this.emitTurnFailureMessage(sessionId, errorMessage),
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
      syntheticallyCompletedToolItemIds: new Set(),
      reasoningDeltaItemIds: new Set(),
      planTextByItemId: new Map(),
      planApprovalRequestedByTurnId: new Set(),
      pendingPlanApprovalsByTurnId: new Map(),
      pendingTurnCompletionsByTurnId: new Map(),
      commandApprovalScopes: new Set(),
      replayedTurnItemKeys: new Set(),
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
      syntheticallyCompletedToolItemIds: new Set(),
      reasoningDeltaItemIds: new Set(),
      planTextByItemId: new Map(),
      planApprovalRequestedByTurnId: new Set(),
      pendingPlanApprovalsByTurnId: new Map(),
      pendingTurnCompletionsByTurnId: new Map(),
      commandApprovalScopes: new Set(),
      replayedTurnItemKeys: new Set(),
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
    await this.streamEventHandler.replayThreadHistory(sessionId, threadId);
  }

  private async handleCodexNotification(method: string, params: unknown): Promise<void> {
    await this.streamEventHandler.handleCodexNotification({ method, params });
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

  private shouldHoldTurnForPlanApproval(
    session: AdapterSession,
    item: { type: string; id: string } & Record<string, unknown>,
    turnId: string
  ): boolean {
    return (
      item.type === 'plan' &&
      isPlanLikeMode(session.defaults.collaborationMode) &&
      !session.planApprovalRequestedByTurnId.has(turnId) &&
      this.extractPlanApprovalText(session, item) !== null
    );
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

  private async handleCodexServerRequest(request: {
    id: string | number | null;
    method: string;
    params?: unknown;
  }): Promise<void> {
    await handleCodexServerPermissionRequest({
      request,
      sessionIdByThreadId: this.sessionIdByThreadId,
      sessions: this.sessions,
      connection: this.connection,
      codex: this.codex,
      emitSessionUpdate: (sessionId, update) => this.emitSessionUpdate(sessionId, update),
      reportShapeDrift: (event, details) => this.reportShapeDrift(event, details),
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
    session.syntheticallyCompletedToolItemIds.clear();
    session.reasoningDeltaItemIds.clear();
    session.pendingTurnCompletionsByTurnId.clear();
  }

  private reportShapeDrift(event: string, details?: unknown): void {
    const count = (this.shapeDriftCounts.get(event) ?? 0) + 1;
    this.shapeDriftCounts.set(event, count);

    const includeDetails = details !== undefined && (count <= 5 || count % 50 === 0);
    const detailsSuffix = includeDetails ? ` details=${toShapeDriftDetails(details)}` : '';
    process.stderr.write(
      `[codex-app-server-acp] shape-drift event=${event} count=${count}${detailsSuffix}\n`
    );
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
