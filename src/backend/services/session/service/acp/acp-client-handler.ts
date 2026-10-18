import crypto from 'node:crypto';
import type {
  Client,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { createLogger } from '@/backend/services/logger.service';
import {
  SUBAGENTS_CHANGED_METHOD,
  subagentsChangedParamsSchema,
} from '@/shared/acp-protocol/subagents';
import { createAcpElicitation } from './acp-elicitation';
import type { AcpPermissionBridge } from './acp-permission-bridge';
import type { AcpRuntimeEvent } from './acp-runtime-events';
import {
  TASK_STATUS_CHANGED_METHOD,
  taskStatusChangedParamsSchema,
} from './acp-task-status-protocol';

export type AcpEventCallback = (sessionId: string, event: AcpRuntimeEvent) => void;
export type AcpLogCallback = (sessionId: string, payload: Record<string, unknown>) => void;

const logger = createLogger('acp-client-handler');

function normalizePlanReview(params: RequestPermissionRequest): RequestPermissionRequest {
  const rawInput = params.toolCall.rawInput;
  const input =
    typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  const codex = params._meta?.codex;
  const hasPlanReviewMetadata =
    typeof codex === 'object' && codex !== null && 'kind' in codex && codex.kind === 'plan_review';
  if (
    !(
      hasPlanReviewMetadata ||
      (params.toolCall.title === 'Implement this plan?' &&
        params.toolCall.kind === 'switch_mode' &&
        typeof input.plan === 'string')
    )
  ) {
    return params;
  }
  return {
    ...params,
    toolCall: {
      ...params.toolCall,
      title: 'ExitPlanMode',
      rawInput: {
        ...input,
        type: 'ExitPlanMode',
        providerContinuesAfterApproval: true,
      },
    },
  };
}

function resolveRejectOptionId(params: RequestPermissionRequest): string | null {
  const rejectOption = params.options.find(
    (option) => option.kind === 'reject_once' || option.kind === 'reject_always'
  );
  return rejectOption?.optionId ?? null;
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

export class AcpClientHandler implements Client {
  private readonly sessionId: string;
  private readonly onEvent: AcpEventCallback;
  private readonly permissionBridge: AcpPermissionBridge | null;
  private readonly onLog: AcpLogCallback | null;

  constructor(
    sessionId: string,
    onEvent: AcpEventCallback,
    permissionBridge?: AcpPermissionBridge,
    onLog?: AcpLogCallback
  ) {
    this.sessionId = sessionId;
    this.onEvent = onEvent;
    this.permissionBridge = permissionBridge ?? null;
    this.onLog = onLog ?? null;
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

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    this.onLog?.(this.sessionId, {
      eventType: 'acp_extension_notification',
      method,
      data: params,
    });

    if (method === TASK_STATUS_CHANGED_METHOD) {
      const parsed = taskStatusChangedParamsSchema.safeParse(params);
      if (!parsed.success) {
        logger.warn('Ignoring malformed ACP task status notification', {
          sessionId: this.sessionId,
          method,
          issues: parsed.error.issues,
        });
        return Promise.resolve();
      }
      this.onEvent(this.sessionId, {
        type: 'acp_task_status_changed',
        active: parsed.data.active,
      });
      return Promise.resolve();
    }

    if (method !== SUBAGENTS_CHANGED_METHOD) {
      logger.debug('Ignoring unknown ACP extension notification', {
        sessionId: this.sessionId,
        method,
      });
      return Promise.resolve();
    }

    const parsed = subagentsChangedParamsSchema.safeParse(params);
    if (!parsed.success) {
      logger.warn('Ignoring malformed ACP sub-agent change notification', {
        sessionId: this.sessionId,
        method,
        issues: parsed.error.issues,
      });
      return Promise.resolve();
    }

    this.onEvent(this.sessionId, {
      type: 'acp_subagents_changed',
      subagentId: parsed.data.subagentId,
      change: parsed.data.change,
    });
    return Promise.resolve();
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // PRESERVE: Log permission request to session file logger
    this.onLog?.(this.sessionId, {
      eventType: 'acp_permission_request',
      toolCallId: params.toolCall.toolCallId,
      options: params.options.map((o) => ({ optionId: o.optionId, kind: o.kind, name: o.name })),
    });

    const request = normalizePlanReview(params);
    const automatic = this.permissionBridge?.resolveAutomaticPermission(request);
    if (automatic) {
      return Promise.resolve(automatic);
    }

    if (!this.permissionBridge) {
      logger.warn('Permission bridge missing; failing closed on ACP permission request', {
        sessionId: this.sessionId,
        toolCallId: request.toolCall.toolCallId,
      });
      return Promise.resolve(resolveFailClosedOutcome({ request, sessionId: this.sessionId }));
    }

    const requestId = crypto.randomUUID();
    const response = this.permissionBridge.waitForUserResponse(requestId, request);
    this.onEvent(this.sessionId, { type: 'acp_permission_request', requestId, params: request });
    return response;
  }

  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    if (!this.permissionBridge) {
      logger.warn('Permission bridge missing; cancelling ACP elicitation', {
        sessionId: this.sessionId,
        mode: params.mode,
      });
      return Promise.resolve({ action: 'cancel' });
    }
    return createAcpElicitation(params, this.sessionId, (request) =>
      this.requestPermission(request)
    );
  }

  completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    this.onLog?.(this.sessionId, {
      eventType: 'acp_elicitation_complete',
      elicitationId: params.elicitationId,
    });
    return Promise.resolve();
  }
}
