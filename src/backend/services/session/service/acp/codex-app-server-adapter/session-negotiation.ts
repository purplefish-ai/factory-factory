import { dedupeStrings, isNonEmptyString } from './acp-adapter-utils';
import type {
  AdapterSession,
  ApprovalPolicy,
  CodexClient,
  CodexModelEntry,
  CollaborationModeEntry,
  ReasoningEffort,
  SandboxMode,
} from './adapter-state';
import {
  collaborationModeListResponseSchema,
  configRequirementsReadResponseSchema,
  modelListResponseSchema,
  threadResumeResponseSchema,
  threadStartResponseSchema,
} from './codex-zod';
import { requestWithOverloadRetry } from './retry-logic';
import { DEFAULT_APPROVAL_POLICIES, DEFAULT_SANDBOX_MODES } from './session-config-resolver';

type SessionDefaults = AdapterSession['defaults'];

export type NegotiatedSession = {
  sessionId: string;
  threadId: string;
  cwd: string;
  defaults: SessionDefaults;
};

type SessionDefaultResolvers = {
  resolveDefaultModel: () => string;
  resolveSessionModel: (model: unknown, fallbackModel: string) => string;
  resolveSandboxPolicy: (sandbox: unknown, cwd: string) => Record<string, unknown>;
  resolveReasoningEffortForModel: (
    modelId: string,
    candidateReasoningEffort: unknown
  ) => ReasoningEffort | null;
  resolveDefaultCollaborationMode: () => string;
};

export function toSessionId(threadId: string): string {
  return `sess_${threadId}`;
}

export function toThreadId(sessionId: string): string {
  return sessionId.startsWith('sess_') ? sessionId.slice('sess_'.length) : sessionId;
}

export function requireApprovalPolicy(
  approvalPolicy: unknown,
  source: 'thread/start' | 'thread/resume'
): ApprovalPolicy {
  if (!isNonEmptyString(approvalPolicy)) {
    throw new Error(`Codex ${source} response did not include approvalPolicy`);
  }
  return approvalPolicy;
}

export async function negotiateNewSession(
  params: {
    codex: CodexClient;
    cwd: string;
  } & SessionDefaultResolvers
): Promise<NegotiatedSession> {
  const defaultModel = params.resolveDefaultModel();
  const responseRaw = await params.codex.request('thread/start', {
    cwd: params.cwd,
    model: defaultModel,
  });

  const response = threadStartResponseSchema.parse(responseRaw);
  const model = params.resolveSessionModel(response.model, defaultModel);

  return {
    sessionId: toSessionId(response.thread.id),
    threadId: response.thread.id,
    cwd: params.cwd,
    defaults: {
      model,
      approvalPolicy: requireApprovalPolicy(response.approvalPolicy, 'thread/start'),
      sandboxPolicy: params.resolveSandboxPolicy(response.sandbox, params.cwd),
      reasoningEffort: params.resolveReasoningEffortForModel(model, response.reasoningEffort),
      collaborationMode: params.resolveDefaultCollaborationMode(),
    },
  };
}

export async function negotiateSessionResume(
  params: {
    codex: CodexClient;
    sessionId: string;
    cwd: string;
  } & SessionDefaultResolvers
): Promise<NegotiatedSession> {
  const responseRaw = await params.codex.request('thread/resume', {
    threadId: toThreadId(params.sessionId),
    cwd: params.cwd,
  });

  const response = threadResumeResponseSchema.parse(responseRaw);
  const defaultModel = params.resolveDefaultModel();
  const model = params.resolveSessionModel(response.model, defaultModel);

  return {
    sessionId: params.sessionId,
    threadId: response.thread.id,
    cwd: params.cwd,
    defaults: {
      model,
      approvalPolicy: requireApprovalPolicy(response.approvalPolicy, 'thread/resume'),
      sandboxPolicy: params.resolveSandboxPolicy(response.sandbox, params.cwd),
      reasoningEffort: params.resolveReasoningEffortForModel(model, response.reasoningEffort),
      collaborationMode: params.resolveDefaultCollaborationMode(),
    },
  };
}

export async function loadConfigRequirements(params: { codex: CodexClient }): Promise<{
  allowedApprovalPolicies: ApprovalPolicy[];
  allowedSandboxModes: SandboxMode[];
}> {
  const raw = await params.codex.request('configRequirements/read', undefined);
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

export async function loadCollaborationModes(params: {
  codex: CodexClient;
}): Promise<CollaborationModeEntry[]> {
  const entries: CollaborationModeEntry[] = [];
  let cursor: string | null = null;

  for (;;) {
    const response = await requestWithOverloadRetry({
      request: () => params.codex.request('collaborationMode/list', cursor ? { cursor } : {}),
      parse: (raw) => collaborationModeListResponseSchema.parse(raw),
    });
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

export async function loadModelCatalog(params: { codex: CodexClient }): Promise<CodexModelEntry[]> {
  const models: CodexModelEntry[] = [];
  let cursor: string | null = null;

  for (;;) {
    const response = await requestWithOverloadRetry({
      request: () => params.codex.request('model/list', cursor ? { cursor } : {}),
      parse: (raw) => modelListResponseSchema.parse(raw),
    });
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
