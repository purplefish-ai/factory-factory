import crypto from 'node:crypto';
import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { createLogger } from '@/backend/services/logger.service';
import type { AcpPermissionBridge } from './acp-permission-bridge';
import type { AcpRuntimeEvent } from './acp-runtime-events';

export type AcpEventCallback = (sessionId: string, event: AcpRuntimeEvent) => void;
export type AcpLogCallback = (sessionId: string, payload: Record<string, unknown>) => void;

/** Controls whether permission requests are auto-approved without user interaction. */
export type AutoApprovePolicy = 'none' | 'all';

const logger = createLogger('acp-client-handler');

function isExitPlanModeApprovalRequest(params: RequestPermissionRequest): boolean {
  if (params.toolCall.title === 'ExitPlanMode') {
    return true;
  }

  const rawInput = params.toolCall.rawInput;
  if (typeof rawInput !== 'object' || rawInput === null) {
    return false;
  }

  const typeValue = (rawInput as { type?: unknown }).type;
  return typeValue === 'ExitPlanMode';
}

function isUserInputPermissionRequest(params: RequestPermissionRequest): boolean {
  if (
    params.toolCall.title === 'AskUserQuestion' ||
    params.toolCall.title === 'item/tool/requestUserInput'
  ) {
    return true;
  }

  const rawInput = params.toolCall.rawInput;
  if (typeof rawInput !== 'object' || rawInput === null) {
    return false;
  }

  const questions = (rawInput as { questions?: unknown }).questions;
  return Array.isArray(questions);
}

function resolveRejectOptionId(params: RequestPermissionRequest): string | null {
  const rejectOption = params.options.find(
    (option) => option.kind === 'reject_once' || option.kind === 'reject_always'
  );
  return rejectOption?.optionId ?? null;
}

function resolveAllowOptionId(params: RequestPermissionRequest): string | null {
  const allowOption = params.options.find(
    (option) => option.kind === 'allow_always' || option.kind === 'allow_once'
  );
  return allowOption?.optionId ?? null;
}

function resolveInteractiveRequestTypeLabel(
  isPlanApproval: boolean
): 'ExitPlanMode' | 'requestUserInput' {
  if (isPlanApproval) {
    return 'ExitPlanMode';
  }
  return 'requestUserInput';
}

function resolveFailClosedOutcome(params: {
  request: RequestPermissionRequest;
  sessionId: string;
}): RequestPermissionResponse {
  const rejectOptionId = resolveRejectOptionId(params.request);
  if (rejectOptionId) {
    return {
      outcome: {
        outcome: 'selected',
        optionId: rejectOptionId,
      },
    };
  }

  logger.warn('Permission request has no reject option; cancelling to fail closed', {
    sessionId: params.sessionId,
    toolCallId: params.request.toolCall.toolCallId,
    availableOptions: params.request.options.map((option) => option.kind),
  });
  return {
    outcome: {
      outcome: 'cancelled',
    },
  };
}

function tryAutoApprovePermission(params: {
  request: RequestPermissionRequest;
  autoApprovePolicy: AutoApprovePolicy;
  bypassesAutoApprove: boolean;
  sessionId: string;
}): RequestPermissionResponse | null {
  if (params.autoApprovePolicy !== 'all' || params.bypassesAutoApprove) {
    return null;
  }

  const allowOptionId = resolveAllowOptionId(params.request);
  if (allowOptionId) {
    logger.debug('Auto-approving permission request per configured preset', {
      sessionId: params.sessionId,
      toolCallId: params.request.toolCall.toolCallId,
    });
    return {
      outcome: {
        outcome: 'selected',
        optionId: allowOptionId,
      },
    };
  }

  logger.warn('Auto-approve enabled but no allow option found; deferring to permission bridge', {
    sessionId: params.sessionId,
    toolCallId: params.request.toolCall.toolCallId,
    availableOptions: params.request.options.map((option) => option.kind),
  });
  return null;
}

function resolveMissingBridgeOutcome(params: {
  request: RequestPermissionRequest;
  bypassesAutoApprove: boolean;
  isPlanApproval: boolean;
  sessionId: string;
  autoApprovePolicy: AutoApprovePolicy;
}): RequestPermissionResponse {
  const shouldAutoApprove = !params.bypassesAutoApprove && params.autoApprovePolicy === 'all';
  const allowOptionId = shouldAutoApprove ? resolveAllowOptionId(params.request) : null;

  if (allowOptionId) {
    logger.warn('Permission bridge missing; auto-approving ACP permission request', {
      sessionId: params.sessionId,
      toolCallId: params.request.toolCall.toolCallId,
      requestType: 'permission',
    });

    return {
      outcome: {
        outcome: 'selected',
        optionId: allowOptionId,
      },
    };
  }

  const outcome = resolveFailClosedOutcome({
    request: params.request,
    sessionId: params.sessionId,
  });
  const failClosedAction = outcome.outcome.outcome === 'cancelled' ? 'cancelling' : 'rejecting';

  logger.warn(
    params.bypassesAutoApprove
      ? `Permission bridge missing; ${failClosedAction} interactive ACP permission request`
      : `Permission bridge missing; ${failClosedAction} ACP permission request`,
    {
      sessionId: params.sessionId,
      toolCallId: params.request.toolCall.toolCallId,
      requestType: params.bypassesAutoApprove
        ? resolveInteractiveRequestTypeLabel(params.isPlanApproval)
        : 'permission',
    }
  );

  return outcome;
}

export class AcpClientHandler implements Client {
  private readonly sessionId: string;
  private readonly onEvent: AcpEventCallback;
  private readonly permissionBridge: AcpPermissionBridge | null;
  private readonly onLog: AcpLogCallback | null;
  private readonly autoApprovePolicy: AutoApprovePolicy;

  constructor(
    sessionId: string,
    onEvent: AcpEventCallback,
    permissionBridge?: AcpPermissionBridge,
    onLog?: AcpLogCallback,
    autoApprovePolicy?: AutoApprovePolicy
  ) {
    this.sessionId = sessionId;
    this.onEvent = onEvent;
    this.permissionBridge = permissionBridge ?? null;
    this.onLog = onLog ?? null;
    this.autoApprovePolicy = autoApprovePolicy ?? 'none';
  }

  sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;

    // PRESERVE: Log ALL events to session file logger (EVENT-06)
    // This logging MUST happen FIRST, before any forwarding or translation.
    this.onLog?.(this.sessionId, {
      eventType: 'acp_session_update',
      sessionUpdate: update.sessionUpdate,
      data: update,
    });

    // Forward the raw update to session service for translation via AcpEventTranslator
    // This replaces the Phase 19 inline switch that only handled 3 event types
    this.onEvent(this.sessionId, { type: 'acp_session_update', update });
    return Promise.resolve();
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // PRESERVE: Log permission request to session file logger
    this.onLog?.(this.sessionId, {
      eventType: 'acp_permission_request',
      toolCallId: params.toolCall.toolCallId,
      options: params.options.map((o) => ({ optionId: o.optionId, kind: o.kind, name: o.name })),
    });

    const isPlanApproval = isExitPlanModeApprovalRequest(params);
    const isUserInputRequest = isUserInputPermissionRequest(params);
    const bypassesAutoApprove = isPlanApproval || isUserInputRequest;

    const autoApproved = tryAutoApprovePermission({
      request: params,
      autoApprovePolicy: this.autoApprovePolicy,
      bypassesAutoApprove,
      sessionId: this.sessionId,
    });
    if (autoApproved) {
      return Promise.resolve(autoApproved);
    }

    if (bypassesAutoApprove && this.autoApprovePolicy === 'all') {
      logger.debug('Bypassing auto-approve for interactive request', {
        sessionId: this.sessionId,
        toolCallId: params.toolCall.toolCallId,
        requestType: isPlanApproval ? 'ExitPlanMode' : 'requestUserInput',
      });
    }

    if (!this.permissionBridge) {
      return Promise.resolve(
        resolveMissingBridgeOutcome({
          request: params,
          bypassesAutoApprove,
          isPlanApproval,
          sessionId: this.sessionId,
          autoApprovePolicy: this.autoApprovePolicy,
        })
      );
    }

    const requestId = crypto.randomUUID();
    // Emit permission request event for WebSocket push
    this.onEvent(this.sessionId, {
      type: 'acp_permission_request',
      requestId,
      params,
    });
    // Suspend until user responds
    return this.permissionBridge.waitForUserResponse(requestId, params);
  }
}
