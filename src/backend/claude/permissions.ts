/**
 * Permission handlers for Claude CLI tool execution.
 *
 * This module provides interfaces and implementations for handling permission
 * requests from the Claude CLI during tool execution. Different handlers support
 * various approval strategies from auto-approve to deferred UI-based approval.
 */

import { EventEmitter } from 'node:events';
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
  /**
   * Called when CLI requests permission for a tool (can_use_tool).
   * Return an AllowResponse or DenyResponse.
   */
  onCanUseTool(request: CanUseToolRequest): Promise<ControlResponseBody>;

  /**
   * Called for PreToolUse hooks.
   * Return a PreToolUseHookResponse.
   */
  onPreToolUseHook(request: HookCallbackRequest): Promise<ControlResponseBody>;

  /**
   * Called for Stop hooks.
   * Return a StopHookResponse.
   */
  onStopHook(request: HookCallbackRequest): Promise<ControlResponseBody>;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create an allow response for can_use_tool requests.
 *
 * Note: updatedInput is required by the Claude CLI Zod schema, not optional.
 * When omitted, defaults to an empty object.
 */
export function createAllowResponse(updatedInput?: Record<string, unknown>): AllowResponseData {
  return {
    behavior: 'allow',
    updatedInput: updatedInput ?? {},
  };
}

/**
 * Create a deny response for can_use_tool requests.
 */
export function createDenyResponse(message: string, interrupt?: boolean): DenyResponseData {
  return {
    behavior: 'deny',
    message,
    ...(interrupt !== undefined && { interrupt }),
  };
}

/**
 * Create a PreToolUse hook response.
 */
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

/**
 * Create a Stop hook response.
 */
export function createStopHookResponse(
  decision: 'approve' | 'block',
  reason?: string
): StopHookResponseData {
  return {
    decision,
    ...(reason && { reason }),
  };
}

/**
 * Interactive tools that require user input, not just permission.
 * These tools should NEVER be auto-approved because they need actual user responses.
 * - AskUserQuestion: needs the user's answers to questions
 * - ExitPlanMode: needs user approval of the proposed plan
 */
export const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Determine if a tool should be auto-approved based on permission mode.
 */
export function shouldAutoApprove(mode: PermissionMode, toolName: string): boolean {
  // Interactive tools should NEVER be auto-approved - they require user input, not just permission
  if (INTERACTIVE_TOOLS.has(toolName)) {
    return false;
  }

  switch (mode) {
    case 'bypassPermissions':
    case 'plan':
      // ExitPlanMode already handled by INTERACTIVE_TOOLS check above
      return true;
    case 'acceptEdits':
      return READ_ONLY_TOOLS.has(toolName) || EDIT_TOOLS.has(toolName);
    case 'delegate':
    case 'dontAsk':
    case 'default':
      // These modes only auto-approve read-only tools
      // Note: dontAsk mode denial is handled by shouldDenyInDontAskMode
      return READ_ONLY_TOOLS.has(toolName);
  }
}

/**
 * Determine if a tool should be denied without asking in dontAsk mode.
 * Returns true if the tool should be denied, false if it can proceed.
 */
export function shouldDenyInDontAskMode(mode: PermissionMode, toolName: string): boolean {
  if (mode !== 'dontAsk') {
    return false;
  }
  // In dontAsk mode, deny tools that aren't read-only and aren't interactive
  // Interactive tools always require user input regardless of mode
  if (INTERACTIVE_TOOLS.has(toolName)) {
    return false;
  }
  return !READ_ONLY_TOOLS.has(toolName);
}

// =============================================================================
// AutoApproveHandler
// =============================================================================

/**
 * Auto-approves all tool executions.
 * Useful for autonomous agent mode.
 */
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

/**
 * Auto-denies all tool executions.
 * Useful for read-only or plan-only modes.
 */
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

/**
 * Mode-based handler that auto-approves based on permission mode and tool type.
 *
 * Mode behaviors:
 * - default: Auto-approve read-only tools, ask for others
 * - acceptEdits: Auto-approve read-only + file edits, ask for Bash
 * - plan: Auto-approve all except ExitPlanMode
 * - bypassPermissions: Auto-approve everything
 * - delegate: Treat like default (ask for non-read-only tools)
 * - dontAsk: Deny all tools that aren't pre-approved (read-only)
 */
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

    // In dontAsk mode, deny tools that aren't pre-approved without asking
    if (shouldDenyInDontAskMode(this.mode, request.tool_name)) {
      return Promise.resolve(
        createDenyResponse(`Tool '${request.tool_name}' not pre-approved in dontAsk mode`)
      );
    }

    // If we have an onAsk callback, use it
    if (this.onAsk) {
      return this.onAsk(request);
    }

    // Default: deny with message asking for manual approval
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
    // Stop hooks typically approve unless there's a specific reason to block
    return Promise.resolve(createStopHookResponse('approve'));
  }

  /**
   * Update the permission mode.
   */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /**
   * Get the current permission mode.
   */
  getMode(): PermissionMode {
    return this.mode;
  }
}

// =============================================================================
// DeferredHandler Types
// =============================================================================

/**
 * Pending request entry for deferred approval.
 */
interface PendingPermissionRequest {
  resolve: (response: ControlResponseBody) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
  request: CanUseToolRequest | HookCallbackRequest;
  type: 'permission' | 'hook';
}

/**
 * Options for DeferredHandler configuration.
 */
export interface DeferredHandlerOptions {
  /** Timeout in milliseconds for pending requests. Default: 0 (no timeout) */
  timeout?: number;
}

// =============================================================================
// DeferredHandler
// =============================================================================

/**
 * Deferred handler that emits events for external approval.
 * Use when UI-based approval is needed.
 *
 * @example
 * ```typescript
 * const handler = new DeferredHandler({ timeout: 60000 });
 *
 * handler.on('permission_request', (request) => {
 *   console.log(`Tool ${request.tool_name} needs approval`);
 *   // Show UI, then call approve/deny
 * });
 *
 * // In UI callback:
 * handler.approve(requestId);
 * // or
 * handler.deny(requestId, 'User rejected');
 * ```
 */
export class DeferredHandler extends EventEmitter implements PermissionHandler {
  private pendingRequests: Map<string, PendingPermissionRequest>;
  private timeout: number;
  private requestCounter: number;

  constructor(options?: DeferredHandlerOptions) {
    super();
    this.pendingRequests = new Map();
    this.timeout = options?.timeout ?? 0; // No timeout by default - user may need time to respond
    this.requestCounter = 0;
  }

  /**
   * Generate a unique request ID for tracking pending requests.
   */
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

      // Emit event with the request and its ID
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

      // Emit event with the request and its ID
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

      // Emit event with the request and its ID
      this.emit('stop_request', request, requestId);
    });
  }

  /**
   * Approve a pending permission request.
   *
   * @param requestId - The ID of the pending request
   * @param updatedInput - Optional updated input to pass to the tool. If not provided,
   *                       the original tool input from the request is used.
   */
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
      // Use provided updatedInput, or fall back to original tool input from the request
      const canUseToolRequest = pending.request as CanUseToolRequest;
      const inputToUse = updatedInput ?? (canUseToolRequest.input as Record<string, unknown>) ?? {};
      pending.resolve(createAllowResponse(inputToUse));
    } else {
      // For hooks, determine the appropriate response based on the hook type
      const hookRequest = pending.request as HookCallbackRequest;
      if (hookRequest.input.hook_event_name === 'Stop') {
        pending.resolve(createStopHookResponse('approve'));
      } else {
        pending.resolve(createPreToolUseHookResponse('allow'));
      }
    }
  }

  /**
   * Deny a pending permission request.
   *
   * @param requestId - The ID of the pending request
   * @param message - The reason for denial
   */
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
      // For hooks, determine the appropriate response based on the hook type
      const hookRequest = pending.request as HookCallbackRequest;
      if (hookRequest.input.hook_event_name === 'Stop') {
        pending.resolve(createStopHookResponse('block', message));
      } else {
        pending.resolve(createPreToolUseHookResponse('deny', message));
      }
    }
  }

  /**
   * Cancel a pending request with an error.
   *
   * @param requestId - The ID of the pending request
   * @param reason - Optional reason for cancellation
   */
  cancel(requestId: string, reason?: string): void {
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      return; // Already resolved or doesn't exist
    }

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    this.pendingRequests.delete(requestId);
    pending.reject(new Error(reason ?? 'Request cancelled'));
  }

  /**
   * Cancel all pending requests.
   */
  cancelAll(reason?: string): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(new Error(reason ?? 'All requests cancelled'));
    }
    this.pendingRequests.clear();
  }

  /**
   * Get the number of pending requests.
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Check if there's a pending request with the given ID.
   */
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
    // The _event and _args are forwarded to super but need underscore prefix
    // to satisfy TypeScript for overload resolution
    return super.emit(_event, ..._args);
  }
}
type EventEmitterListener = Parameters<EventEmitter['on']>[1];
type EventEmitterEmitArgs =
  Parameters<EventEmitter['emit']> extends [unknown, ...infer Args] ? Args : never;
