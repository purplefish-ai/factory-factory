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

    // Auto-approve when configured (YOLO/RELAXED permission preset)
    if (this.autoApprovePolicy === 'all') {
      const allowOption = params.options.find(
        (o) => o.kind === 'allow_always' || o.kind === 'allow_once'
      );
      if (allowOption) {
        logger.debug('Auto-approving permission request per configured preset', {
          sessionId: this.sessionId,
          toolCallId: params.toolCall.toolCallId,
        });
        return Promise.resolve({
          outcome: {
            outcome: 'selected',
            optionId: allowOption.optionId,
          },
        });
      }
      // No allow option available; fall through to interactive permission bridge
      logger.warn(
        'Auto-approve enabled but no allow option found; deferring to permission bridge',
        {
          sessionId: this.sessionId,
          toolCallId: params.toolCall.toolCallId,
          availableOptions: params.options.map((o) => o.kind),
        }
      );
    }

    if (!this.permissionBridge) {
      // Fallback for non-interactive contexts; production paths should inject permissionBridge.
      logger.warn('Permission bridge missing; auto-approving ACP permission request', {
        sessionId: this.sessionId,
        toolCallId: params.toolCall.toolCallId,
      });
      const allowOption = params.options.find(
        (o) => o.kind === 'allow_always' || o.kind === 'allow_once'
      );
      return Promise.resolve({
        outcome: {
          outcome: 'selected',
          optionId: allowOption?.optionId ?? params.options[0]?.optionId ?? 'unknown',
        },
      });
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
