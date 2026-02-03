/**
 * Permission coordination for Claude CLI control requests.
 *
 * Bridges protocol control requests with permission handlers and
 * interactive approval flows.
 */

import { EventEmitter } from 'node:events';
import { AskUserQuestionInputSchema, safeParseToolInput } from '../schemas/tool-inputs.schema';
import { createLogger } from '../services/logger.service';
import {
  createAllowResponse,
  DeferredHandler,
  INTERACTIVE_TOOLS,
  type PermissionHandler,
} from './permissions';
import type { ControlResponseBody } from './protocol';
import type { ProtocolIO } from './protocol-io';
import type {
  CanUseToolRequest,
  ControlCancelRequest,
  ControlRequest,
  HookCallbackRequest,
} from './types';
import { isCanUseToolRequest, isHookCallbackRequest } from './types';

const logger = createLogger('claude-permissions');

export interface PendingInteractiveRequest {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

export interface PermissionCoordinatorOptions {
  permissionHandler: PermissionHandler;
  interactiveHandler?: DeferredHandler;
  interactiveTimeoutMs?: number;
}

export interface PermissionCoordinatorEvents {
  permission_request: (request: ControlRequest) => void;
  interactive_request: (request: PendingInteractiveRequest) => void;
  permission_cancelled: (requestId: string) => void;
}

export class ClaudePermissionCoordinator extends EventEmitter {
  private permissionHandler: PermissionHandler;
  private interactiveHandler: DeferredHandler;
  private pendingInteractiveRequests: Map<string, CanUseToolRequest> = new Map();
  private protocolToToolRequestId: Map<string, string> = new Map();
  private cancelledProtocolRequests: Set<string> = new Set();
  private protocol: ProtocolIO | null = null;
  private boundHandlers: {
    onControlRequest: (request: ControlRequest) => void;
    onControlCancel: (request: ControlCancelRequest) => void;
  } | null = null;

  constructor(options: PermissionCoordinatorOptions) {
    super();
    this.permissionHandler = options.permissionHandler;
    this.interactiveHandler =
      options.interactiveHandler ??
      new DeferredHandler({ timeout: options.interactiveTimeoutMs ?? 300_000 });

    this.interactiveHandler.on('permission_request', (request, requestId) => {
      this.pendingInteractiveRequests.set(requestId, request);

      this.emit('interactive_request', {
        requestId,
        toolName: request.tool_name,
        toolUseId: request.tool_use_id ?? requestId,
        input: request.input,
      });
    });

    this.interactiveHandler.on('request_timeout', (requestId) => {
      this.pendingInteractiveRequests.delete(requestId);
    });
  }

  bind(protocol: ProtocolIO): void {
    if (this.protocol) {
      this.unbind();
    }

    this.protocol = protocol;

    const onControlRequest = (controlRequest: ControlRequest) => {
      void this.handleControlRequestMessage(controlRequest);
    };

    const onControlCancel = (cancelRequest: ControlCancelRequest) => {
      this.handleControlCancelMessage(cancelRequest);
    };

    this.boundHandlers = { onControlRequest, onControlCancel };

    protocol.on('control_request', onControlRequest);
    protocol.on('control_cancel', onControlCancel);
  }

  unbind(): void {
    if (!(this.protocol && this.boundHandlers)) {
      this.protocol = null;
      this.boundHandlers = null;
      return;
    }

    this.protocol.removeListener('control_request', this.boundHandlers.onControlRequest);
    this.protocol.removeListener('control_cancel', this.boundHandlers.onControlCancel);
    this.protocol = null;
    this.boundHandlers = null;
  }

  stop(reason?: string): void {
    this.pendingInteractiveRequests.clear();
    this.interactiveHandler.cancelAll(reason ?? 'Permission coordinator stopped');
  }

  answerQuestion(requestId: string, answers: Record<string, string | string[]>): void {
    const storedRequest = this.pendingInteractiveRequests.get(requestId);
    if (!storedRequest) {
      throw new Error(`No pending interactive request found with ID: ${requestId}`);
    }

    const parsed = safeParseToolInput(
      AskUserQuestionInputSchema,
      storedRequest.input,
      'AskUserQuestion'
    );
    if (!parsed.success) {
      throw new Error(`Invalid AskUserQuestion input for request ID: ${requestId}`);
    }
    const questions = parsed.data.questions;

    this.pendingInteractiveRequests.delete(requestId);
    this.interactiveHandler.approve(requestId, { questions, answers });
  }

  approveInteractiveRequest(requestId: string): void {
    const storedRequest = this.pendingInteractiveRequests.get(requestId);
    if (!storedRequest) {
      throw new Error(`No pending interactive request found with ID: ${requestId}`);
    }

    this.pendingInteractiveRequests.delete(requestId);
    this.interactiveHandler.approve(requestId, storedRequest.input);
  }

  denyInteractiveRequest(requestId: string, reason: string): void {
    this.pendingInteractiveRequests.delete(requestId);
    this.interactiveHandler.deny(requestId, reason);
  }

  private async handleControlRequestMessage(controlRequest: ControlRequest): Promise<void> {
    this.emit('permission_request', controlRequest);

    if (
      isCanUseToolRequest(controlRequest.request) &&
      INTERACTIVE_TOOLS.has(controlRequest.request.tool_name)
    ) {
      const toolUseId = controlRequest.request.tool_use_id;
      if (toolUseId) {
        this.protocolToToolRequestId.set(controlRequest.request_id, toolUseId);
      }
    }

    try {
      const response = await this.handleControlRequest(controlRequest.request);
      this.protocolToToolRequestId.delete(controlRequest.request_id);
      await this.protocol?.sendControlResponse(controlRequest.request_id, response);
    } catch (error) {
      this.protocolToToolRequestId.delete(controlRequest.request_id);

      if (this.cancelledProtocolRequests.has(controlRequest.request_id)) {
        this.cancelledProtocolRequests.delete(controlRequest.request_id);
        logger.debug('Skipping deny response for cancelled request', {
          requestId: controlRequest.request_id,
        });
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.protocol?.sendControlResponse(controlRequest.request_id, {
        behavior: 'deny',
        message: `Permission handler error: ${errorMessage}`,
      });
    }
  }

  private handleControlCancelMessage(cancelRequest: ControlCancelRequest): void {
    const toolUseId = this.protocolToToolRequestId.get(cancelRequest.request_id);
    const requestIdToCancel = toolUseId ?? cancelRequest.request_id;

    logger.debug('Control cancel received', {
      protocolRequestId: cancelRequest.request_id,
      toolUseId,
      requestIdToCancel,
    });

    this.cancelledProtocolRequests.add(cancelRequest.request_id);
    this.interactiveHandler.cancel(requestIdToCancel, 'Request cancelled by CLI');

    const hadStoredRequest = this.pendingInteractiveRequests.has(requestIdToCancel);
    this.pendingInteractiveRequests.delete(requestIdToCancel);
    this.protocolToToolRequestId.delete(cancelRequest.request_id);

    logger.debug('Request cancelled cleanup', {
      requestIdToCancel,
      hadStoredRequest,
    });

    this.emit('permission_cancelled', requestIdToCancel);
  }

  private async handleControlRequest(
    request: ControlRequest['request']
  ): Promise<ControlResponseBody> {
    if (isCanUseToolRequest(request)) {
      if (INTERACTIVE_TOOLS.has(request.tool_name)) {
        return await this.interactiveHandler.onCanUseTool(request);
      }
      return await this.permissionHandler.onCanUseTool(request);
    }

    if (isHookCallbackRequest(request)) {
      return await this.handleHookCallback(request);
    }

    return {
      behavior: 'deny',
      message: `Unknown request subtype: ${(request as { subtype?: string }).subtype ?? 'undefined'}`,
    };
  }

  private async handleHookCallback(request: HookCallbackRequest): Promise<ControlResponseBody> {
    const hookEventName = request.input.hook_event_name;

    if (hookEventName === 'PreToolUse') {
      return await this.permissionHandler.onPreToolUseHook(request);
    }

    if (hookEventName === 'Stop') {
      return await this.permissionHandler.onStopHook(request);
    }

    return createAllowResponse();
  }

  // =========================================================================
  // Event Emitter Overloads (for TypeScript)
  // =========================================================================

  override on<K extends keyof PermissionCoordinatorEvents>(
    event: K,
    handler: PermissionCoordinatorEvents[K]
  ): this;
  override on(event: string, handler: (...args: unknown[]) => void): this {
    return super.on(event, handler);
  }

  override emit<K extends keyof PermissionCoordinatorEvents>(
    event: K,
    ...args: Parameters<PermissionCoordinatorEvents[K]>
  ): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}
