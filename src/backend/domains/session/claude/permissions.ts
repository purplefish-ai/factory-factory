/**
 * Permission handlers for Claude CLI tool execution.
 *
 * This module provides interfaces and implementations for handling permission
 * requests from the Claude CLI during tool execution. Different handlers support
 * various approval strategies from auto-approve to deferred UI-based approval.
 */

import { EventEmitter } from 'node:events';
import type { EventEmitterEmitArgs, EventEmitterListener } from '@/backend/lib/event-emitter-types';
import type { ControlResponseBody } from './protocol';
import type {
  AllowResponseData,
  CanUseToolRequest,
  DenyResponseData,
  HookCallbackRequest,
  PermissionMode,
  PreToolUseHookResponseData,
  StopHookResponseData,
} from './types';

// =============================================================================
// Constants
// =============================================================================

/**
 * Read-only tools that are auto-approved in default mode.
 * These tools don't modify the filesystem or execute arbitrary code.
 */
export const READ_ONLY_TOOLS = new Set([
  'Glob',
  'Grep',
  'Read',
  'NotebookRead',
  'Task',
  'TodoWrite',
  'TodoRead',
]);

/**
 * Edit tools that modify files but don't execute arbitrary code.
 * These are auto-approved in acceptEdits mode.
 */
export const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'UndoEdit', 'NotebookEdit']);

// =============================================================================
// Permission Handler Interface
// =============================================================================

/**
 * Interface for handling permission requests from Claude CLI.
 * Implementations decide whether to allow/deny tool execution.
 */
export interface PermissionHandler {
  onCanUseTool(request: CanUseToolRequest): Promise<ControlResponseBody>;
  onPreToolUseHook(request: HookCallbackRequest): Promise<ControlResponseBody>;
  onStopHook(request: HookCallbackRequest): Promise<ControlResponseBody>;
}

// =============================================================================
// Helper Functions
// =============================================================================

export function createAllowResponse(updatedInput?: Record<string, unknown>): AllowResponseData {
  return {
    behavior: 'allow',
    updatedInput: updatedInput ?? {},
  };
}

export function createDenyResponse(message: string, interrupt?: boolean): DenyResponseData {
  return {
    behavior: 'deny',
    message,
    ...(interrupt !== undefined && { interrupt }),
  };
}

export function createPreToolUseHookResponse(
  decision: 'allow' | 'deny' | 'ask',
  reason?: string
): PreToolUseHookResponseData {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reason && { permissionDecisionReason: reason }),
    },
  };
}

export function createStopHookResponse(
  decision: 'approve' | 'block',
  reason?: string
): StopHookResponseData {
  return {
    decision,
    ...(reason && { reason }),
  };
}

export const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

export function shouldAutoApprove(mode: PermissionMode, toolName: string): boolean {
  if (INTERACTIVE_TOOLS.has(toolName)) {
    return false;
  }

  switch (mode) {
    case 'bypassPermissions':
    case 'plan':
      return true;
    case 'acceptEdits':
      return READ_ONLY_TOOLS.has(toolName) || EDIT_TOOLS.has(toolName);
    case 'delegate':
    case 'dontAsk':
    case 'default':
      return READ_ONLY_TOOLS.has(toolName);
  }
}

export function shouldDenyInDontAskMode(mode: PermissionMode, toolName: string): boolean {
  if (mode !== 'dontAsk') {
    return false;
  }
  if (INTERACTIVE_TOOLS.has(toolName)) {
    return false;
  }
  return !READ_ONLY_TOOLS.has(toolName);
}

// =============================================================================
// AutoApproveHandler
// =============================================================================

export class AutoApproveHandler implements PermissionHandler {
  onCanUseTool(request: CanUseToolRequest): Promise<ControlResponseBody> {
    return Promise.resolve(createAllowResponse(request.input as Record<string, unknown>));
  }

  onPreToolUseHook(_request: HookCallbackRequest): Promise<ControlResponseBody> {
    return Promise.resolve(createPreToolUseHookResponse('allow'));
  }

  onStopHook(_request: HookCallbackRequest): Promise<ControlResponseBody> {
    return Promise.resolve(createStopHookResponse('approve'));
  }
}

// =============================================================================
// AutoDenyHandler
// =============================================================================

export class AutoDenyHandler implements PermissionHandler {
  private message: string;

  constructor(message?: string) {
    this.message = message ?? 'Tool execution not allowed';
  }

  onCanUseTool(_request: CanUseToolRequest): Promise<ControlResponseBody> {
    return Promise.resolve(createDenyResponse(this.message));
  }

  onPreToolUseHook(_request: HookCallbackRequest): Promise<ControlResponseBody> {
    return Promise.resolve(createPreToolUseHookResponse('deny', this.message));
  }

  onStopHook(_request: HookCallbackRequest): Promise<ControlResponseBody> {
    return Promise.resolve(createStopHookResponse('block', this.message));
  }
}

// =============================================================================
// ModeBasedHandler
// =============================================================================

export class ModeBasedHandler implements PermissionHandler {
  private mode: PermissionMode;
  private onAsk?: (request: CanUseToolRequest) => Promise<ControlResponseBody>;

  constructor(
    mode: PermissionMode,
    onAsk?: (request: CanUseToolRequest) => Promise<ControlResponseBody>
  ) {
    this.mode = mode;
    this.onAsk = onAsk;
  }

  onCanUseTool(request: CanUseToolRequest): Promise<ControlResponseBody> {
    if (shouldAutoApprove(this.mode, request.tool_name)) {
      return Promise.resolve(createAllowResponse(request.input as Record<string, unknown>));
    }

    if (shouldDenyInDontAskMode(this.mode, request.tool_name)) {
      return Promise.resolve(
        createDenyResponse(`Tool '${request.tool_name}' not pre-approved in dontAsk mode`)
      );
    }

    if (this.onAsk) {
      return this.onAsk(request);
    }

    return Promise.resolve(
      createDenyResponse(`Tool '${request.tool_name}' requires manual approval`)
    );
  }

  onPreToolUseHook(request: HookCallbackRequest): Promise<ControlResponseBody> {
    const toolName = request.input.tool_name;

    if (!toolName) {
      return Promise.resolve(createPreToolUseHookResponse('ask', 'No tool name provided'));
    }

    if (shouldAutoApprove(this.mode, toolName)) {
      return Promise.resolve(createPreToolUseHookResponse('allow'));
    }

    return Promise.resolve(
      createPreToolUseHookResponse('ask', `Tool '${toolName}' requires approval`)
    );
  }

  onStopHook(_request: HookCallbackRequest): Promise<ControlResponseBody> {
    return Promise.resolve(createStopHookResponse('approve'));
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }
}

// =============================================================================
// DeferredHandler Types
// =============================================================================

interface PendingPermissionRequest {
  resolve: (response: ControlResponseBody) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
  request: CanUseToolRequest | HookCallbackRequest;
  type: 'permission' | 'hook';
}

export interface DeferredHandlerOptions {
  timeout?: number;
}

// =============================================================================
// DeferredHandler
// =============================================================================

export class DeferredHandler extends EventEmitter implements PermissionHandler {
  private pendingRequests: Map<string, PendingPermissionRequest>;
  private timeout: number;
  private requestCounter: number;

  constructor(options?: DeferredHandlerOptions) {
    super();
    this.pendingRequests = new Map();
    this.timeout = options?.timeout ?? 0;
    this.requestCounter = 0;
  }

  private generateRequestId(): string {
    this.requestCounter += 1;
    return `deferred-${Date.now()}-${this.requestCounter}`;
  }

  onCanUseTool(request: CanUseToolRequest): Promise<ControlResponseBody> {
    const requestId = request.tool_use_id ?? this.generateRequestId();

    return new Promise<ControlResponseBody>((resolve, reject) => {
      const timeoutId =
        this.timeout > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(requestId);
              this.emit('request_timeout', requestId, request);
              reject(new Error(`Permission request timed out after ${this.timeout}ms`));
            }, this.timeout)
          : undefined;

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutId,
        request,
        type: 'permission',
      });

      this.emit('permission_request', request, requestId);
    });
  }

  onPreToolUseHook(request: HookCallbackRequest): Promise<ControlResponseBody> {
    const requestId = request.callback_id ?? this.generateRequestId();

    return new Promise<ControlResponseBody>((resolve, reject) => {
      const timeoutId =
        this.timeout > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(requestId);
              reject(new Error(`Hook request timed out after ${this.timeout}ms`));
            }, this.timeout)
          : undefined;

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutId,
        request,
        type: 'hook',
      });

      this.emit('hook_request', request, requestId);
    });
  }

  onStopHook(request: HookCallbackRequest): Promise<ControlResponseBody> {
    const requestId = request.callback_id ?? this.generateRequestId();

    return new Promise<ControlResponseBody>((resolve, reject) => {
      const timeoutId =
        this.timeout > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(requestId);
              reject(new Error(`Stop hook request timed out after ${this.timeout}ms`));
            }, this.timeout)
          : undefined;

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutId,
        request,
        type: 'hook',
      });

      this.emit('stop_request', request, requestId);
    });
  }

  approve(requestId: string, updatedInput?: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      throw new Error(`No pending request found with ID: ${requestId}`);
    }

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    this.pendingRequests.delete(requestId);

    if (pending.type === 'permission') {
      const canUseToolRequest = pending.request as CanUseToolRequest;
      const inputToUse = updatedInput ?? (canUseToolRequest.input as Record<string, unknown>) ?? {};
      pending.resolve(createAllowResponse(inputToUse));
    } else {
      const hookRequest = pending.request as HookCallbackRequest;
      if (hookRequest.input.hook_event_name === 'Stop') {
        pending.resolve(createStopHookResponse('approve'));
      } else {
        pending.resolve(createPreToolUseHookResponse('allow'));
      }
    }
  }

  deny(requestId: string, message: string): void {
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      throw new Error(`No pending request found with ID: ${requestId}`);
    }

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    this.pendingRequests.delete(requestId);

    if (pending.type === 'permission') {
      pending.resolve(createDenyResponse(message));
    } else {
      const hookRequest = pending.request as HookCallbackRequest;
      if (hookRequest.input.hook_event_name === 'Stop') {
        pending.resolve(createStopHookResponse('block', message));
      } else {
        pending.resolve(createPreToolUseHookResponse('deny', message));
      }
    }
  }

  cancel(requestId: string, reason?: string): void {
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      return;
    }

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    this.pendingRequests.delete(requestId);
    pending.reject(new Error(reason ?? 'Request cancelled'));
  }

  cancelAll(reason?: string): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(new Error(reason ?? 'All requests cancelled'));
    }
    this.pendingRequests.clear();
  }

  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  hasPendingRequest(requestId: string): boolean {
    return this.pendingRequests.has(requestId);
  }

  // ===========================================================================
  // Event Emitter Overloads (for TypeScript)
  // ===========================================================================

  override on(
    event: 'permission_request',
    handler: (request: CanUseToolRequest, requestId: string) => void
  ): this;
  override on(
    event: 'hook_request',
    handler: (request: HookCallbackRequest, requestId: string) => void
  ): this;
  override on(
    event: 'stop_request',
    handler: (request: HookCallbackRequest, requestId: string) => void
  ): this;
  override on(
    event: 'request_timeout',
    handler: (requestId: string, request: CanUseToolRequest | HookCallbackRequest) => void
  ): this;
  override on(event: string, handler: EventEmitterListener): this {
    return super.on(event, handler);
  }

  override emit(
    event: 'permission_request',
    request: CanUseToolRequest,
    requestId: string
  ): boolean;
  override emit(event: 'hook_request', request: HookCallbackRequest, requestId: string): boolean;
  override emit(event: 'stop_request', request: HookCallbackRequest, requestId: string): boolean;
  override emit(
    event: 'request_timeout',
    requestId: string,
    request: CanUseToolRequest | HookCallbackRequest
  ): boolean;
  override emit(event: string, ...args: EventEmitterEmitArgs): boolean;
  override emit(_event: string, ..._args: EventEmitterEmitArgs): boolean {
    return super.emit(_event, ..._args);
  }
}
