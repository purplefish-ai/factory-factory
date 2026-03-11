import type {
  AgentSideConnection,
  RequestPermissionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import { asString, isRecord, resolveToolCallId } from './acp-adapter-utils';
import type {
  AdapterSession,
  CodexClient,
  ToolCallState,
  ToolUserInputQuestion,
  UserInputAnswers,
} from './adapter-state';
import { knownCodexServerRequestSchema } from './codex-zod';
import { buildCommandApprovalScopeKey, resolveCommandDisplay } from './command-metadata';

type KnownCodexServerRequest = ReturnType<typeof knownCodexServerRequestSchema.parse>;

type CodexServerRequestPayload = {
  id: string | number | null;
  method: string;
  params?: unknown;
};

type PermissionOptions = Array<{
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once';
}>;

type HandleProtocolPermissionRequestParams = {
  request: CodexServerRequestPayload;
  sessionIdByThreadId: Map<string, string>;
  sessions: Map<string, AdapterSession>;
  connection: Pick<AgentSideConnection, 'requestPermission'>;
  codex: Pick<CodexClient, 'respondSuccess' | 'respondError'>;
  emitSessionUpdate: (sessionId: string, update: SessionUpdate) => Promise<void>;
  reportShapeDrift: (event: string, details?: unknown) => void;
};

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

function buildPermissionOptions(params: {
  method:
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/requestApproval'
    | 'item/tool/requestUserInput';
  questions: ToolUserInputQuestion[];
}): PermissionOptions {
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

function buildApprovalToolCallState(
  session: AdapterSession,
  method:
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/requestApproval'
    | 'item/tool/requestUserInput',
  itemId: string,
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

function isAllowedPermissionSelection(selectedOptionId: string | null): boolean {
  return selectedOptionId === 'allow_once' || selectedOptionId === 'allow_always';
}

async function handleToolUserInputPermissionResponse(params: {
  request: KnownCodexServerRequest;
  permission: RequestPermissionResponse;
  session: AdapterSession;
  toolCallId: string;
  questions: ToolUserInputQuestion[];
  selectedOptionId: string | null;
  codex: Pick<CodexClient, 'respondSuccess' | 'respondError'>;
  emitSessionUpdate: (sessionId: string, update: SessionUpdate) => Promise<void>;
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
    params.codex.respondError(params.request.id, {
      code: -32_602,
      message: 'Failed to map requestUserInput answers',
      data: { error: message },
    });
    await params.emitSessionUpdate(params.session.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: 'failed',
      rawOutput: { error: message },
    });
    return true;
  }

  params.codex.respondSuccess(params.request.id, {
    answers,
  });

  await params.emitSessionUpdate(params.session.sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: params.toolCallId,
    status: rejected ? 'failed' : 'completed',
    rawOutput: rejected ? { outcome: 'rejected' } : { answers },
  });
  return true;
}

async function respondToCodexPermissionRequest(params: {
  request: KnownCodexServerRequest;
  permission: RequestPermissionResponse;
  session: AdapterSession;
  toolCallId: string;
  questions: ToolUserInputQuestion[];
  codex: Pick<CodexClient, 'respondSuccess' | 'respondError'>;
  emitSessionUpdate: (sessionId: string, update: SessionUpdate) => Promise<void>;
  reportShapeDrift: (event: string, details?: unknown) => void;
}): Promise<void> {
  const selected =
    params.permission.outcome.outcome === 'selected' ? params.permission.outcome.optionId : null;
  if (
    await handleToolUserInputPermissionResponse({
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
    const scopeKey = buildCommandApprovalScopeKey({
      command: asString(params.request.params.command),
      cwd: asString(params.request.params.cwd) ?? params.session.cwd,
    });
    if (scopeKey) {
      params.session.commandApprovalScopes.add(scopeKey);
    } else {
      params.reportShapeDrift('allow_always_without_scope_key', {
        itemId: params.request.params.itemId,
        command: params.request.params.command,
      });
    }
  }
  const allow = isAllowedPermissionSelection(selected);

  params.codex.respondSuccess(params.request.id, {
    decision: allow ? 'accept' : 'decline',
  });

  await params.emitSessionUpdate(params.session.sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: params.toolCallId,
    status: allow ? 'in_progress' : 'failed',
    rawOutput: { decision: allow ? 'accept' : 'decline' },
  });
}

async function maybeAutoApproveCommandRequest(params: {
  request: KnownCodexServerRequest;
  session: AdapterSession;
  toolCallId: string;
  codex: Pick<CodexClient, 'respondSuccess' | 'respondError'>;
  emitSessionUpdate: (sessionId: string, update: SessionUpdate) => Promise<void>;
  reportShapeDrift: (event: string, details?: unknown) => void;
}): Promise<boolean> {
  if (params.request.method !== 'item/commandExecution/requestApproval') {
    return false;
  }
  const scopeKey = buildCommandApprovalScopeKey({
    command: asString(params.request.params.command),
    cwd: asString(params.request.params.cwd) ?? params.session.cwd,
  });
  if (!(scopeKey && params.session.commandApprovalScopes.has(scopeKey))) {
    return false;
  }

  await respondToCodexPermissionRequest({
    request: params.request,
    permission: {
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    },
    session: params.session,
    toolCallId: params.toolCallId,
    questions: [],
    codex: params.codex,
    emitSessionUpdate: params.emitSessionUpdate,
    reportShapeDrift: params.reportShapeDrift,
  });
  return true;
}

export async function handleCodexServerPermissionRequest(
  params: HandleProtocolPermissionRequestParams
): Promise<void> {
  try {
    const parsed = knownCodexServerRequestSchema.safeParse(params.request);
    if (!parsed.success) {
      params.reportShapeDrift('malformed_server_request', {
        method: params.request.method,
        issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message),
      });
      params.codex.respondError(params.request.id, {
        code: -32_602,
        message: 'Unsupported codex server request payload',
      });
      return;
    }

    const typed = parsed.data;
    const sessionId = params.sessionIdByThreadId.get(typed.params.threadId);
    if (!sessionId) {
      params.reportShapeDrift('request_for_unknown_thread', {
        method: typed.method,
        threadId: typed.params.threadId,
        itemId: typed.params.itemId,
      });
      params.codex.respondError(typed.id, {
        code: -32_603,
        message: 'No ACP session mapped for this thread',
      });
      return;
    }

    const session = params.sessions.get(sessionId);
    if (!session) {
      params.reportShapeDrift('request_for_missing_session', {
        method: typed.method,
        sessionId,
        itemId: typed.params.itemId,
      });
      params.codex.respondError(typed.id, {
        code: -32_603,
        message: 'No ACP session mapped for this thread',
      });
      return;
    }

    const existingTool = session.toolCallsByItemId.get(typed.params.itemId);
    const toolCall =
      existingTool ??
      buildApprovalToolCallState(session, typed.method, typed.params.itemId, typed.params);
    session.toolCallsByItemId.set(typed.params.itemId, toolCall);

    if (!existingTool) {
      await params.emitSessionUpdate(sessionId, {
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
      await maybeAutoApproveCommandRequest({
        request: typed,
        session,
        toolCallId: toolCall.toolCallId,
        codex: params.codex,
        emitSessionUpdate: params.emitSessionUpdate,
        reportShapeDrift: params.reportShapeDrift,
      })
    ) {
      return;
    }

    const questions = typed.method === 'item/tool/requestUserInput' ? typed.params.questions : [];
    const permissionOptions = buildPermissionOptions({
      method: typed.method,
      questions,
    });

    await params.emitSessionUpdate(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: toolCall.toolCallId,
      title: toolCall.title,
      kind: toolCall.kind,
      status: 'pending',
      ...(toolCall.locations.length > 0 ? { locations: toolCall.locations } : {}),
    });

    const permissionResult = await params.connection.requestPermission({
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

    await respondToCodexPermissionRequest({
      request: typed,
      permission: permissionResult,
      session,
      toolCallId: toolCall.toolCallId,
      questions,
      codex: params.codex,
      emitSessionUpdate: params.emitSessionUpdate,
      reportShapeDrift: params.reportShapeDrift,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.codex.respondError(params.request.id, {
      code: -32_600,
      message: 'Failed to process codex approval request',
      data: { error: message },
    });
  }
}
