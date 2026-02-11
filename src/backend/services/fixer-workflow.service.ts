export interface FixerLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error: Error, meta?: Record<string, unknown>): void;
}

export interface FixerClient {
  isRunning(): boolean;
  sendMessage(message: string): Promise<void>;
}

export interface AcquireAndDispatchRequest {
  workspaceId: string;
  workflow: string;
  sessionName: string;
  runningIdleAction: 'send_message' | 'restart' | 'already_active';
  buildPrompt: () => string | Promise<string>;
}

export type AcquireAndDispatchResponse =
  | { status: 'started'; sessionId: string; promptSent?: boolean }
  | { status: 'already_active'; sessionId: string; reason?: 'working' | 'message_dispatched' }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

export type FixWorkflowResult =
  | { status: 'started'; sessionId: string }
  | { status: 'already_fixing'; sessionId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

export async function runExclusiveWorkspaceOperation<T>(params: {
  pendingMap: Map<string, Promise<T>>;
  workspaceId: string;
  logger: FixerLogger;
  duplicateOperationMessage: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const { pendingMap, workspaceId, logger, duplicateOperationMessage, operation } = params;
  const pending = pendingMap.get(workspaceId);
  if (pending) {
    logger.debug(duplicateOperationMessage, { workspaceId });
    return pending;
  }

  const promise = operation();
  pendingMap.set(workspaceId, promise);
  try {
    return await promise;
  } finally {
    pendingMap.delete(workspaceId);
  }
}

export async function dispatchFixWorkflow(params: {
  workspaceId: string;
  workflow: string;
  sessionName: string;
  runningIdleAction: 'send_message' | 'restart' | 'already_active';
  acquireAndDispatch: (input: AcquireAndDispatchRequest) => Promise<AcquireAndDispatchResponse>;
  buildPrompt: () => string | Promise<string>;
  logger: FixerLogger;
  startedLogMessage: string;
  failureLogMessage: string;
  startedLogMeta?: Record<string, unknown>;
  errorLogMeta?: Record<string, unknown>;
}): Promise<FixWorkflowResult> {
  const {
    workspaceId,
    workflow,
    sessionName,
    runningIdleAction,
    acquireAndDispatch,
    buildPrompt,
    logger,
    startedLogMessage,
    failureLogMessage,
    startedLogMeta,
    errorLogMeta,
  } = params;

  try {
    const result = await acquireAndDispatch({
      workspaceId,
      workflow,
      sessionName,
      runningIdleAction,
      buildPrompt,
    });

    if (result.status === 'started') {
      logger.info(startedLogMessage, {
        workspaceId,
        sessionId: result.sessionId,
        ...startedLogMeta,
      });
      return { status: 'started', sessionId: result.sessionId };
    }

    if (result.status === 'already_active') {
      return { status: 'already_fixing', sessionId: result.sessionId };
    }

    if (result.status === 'skipped') {
      return { status: 'skipped', reason: result.reason };
    }

    return { status: 'error', error: result.error };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(failureLogMessage, error as Error, {
      workspaceId,
      ...errorLogMeta,
    });
    return { status: 'error', error: errorMessage };
  }
}

export async function isFixWorkflowInProgress(params: {
  workspaceId: string;
  workflow: string;
  getActiveSession: (workspaceId: string, workflow: string) => Promise<{ id: string } | null>;
  isSessionWorking: (sessionId: string) => boolean;
}): Promise<boolean> {
  const session = await params.getActiveSession(params.workspaceId, params.workflow);
  if (!session) {
    return false;
  }
  return params.isSessionWorking(session.id);
}

export async function notifyFixWorkflowSession(params: {
  workspaceId: string;
  workflow: string;
  getActiveSession: (workspaceId: string, workflow: string) => Promise<{ id: string } | null>;
  getClient: (sessionId: string) => FixerClient | null;
  message: string;
  logger: FixerLogger;
  successLogMessage: string;
  failureLogMessage: string;
}): Promise<boolean> {
  const {
    workspaceId,
    workflow,
    getActiveSession,
    getClient,
    message,
    logger,
    successLogMessage,
    failureLogMessage,
  } = params;
  const session = await getActiveSession(workspaceId, workflow);
  if (!session) {
    return false;
  }

  const client = getClient(session.id);
  if (!client?.isRunning()) {
    return false;
  }

  client.sendMessage(message).catch((error) => {
    logger.warn(failureLogMessage, { workspaceId, error });
  });

  logger.info(successLogMessage, {
    workspaceId,
    sessionId: session.id,
  });

  return true;
}
