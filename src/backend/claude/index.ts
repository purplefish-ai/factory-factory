/**
 * Unified Claude CLI client.
 *
 * Provides a high-level API for interacting with the Claude CLI via
 * the streaming JSON protocol. Combines process management, protocol
 * handling, permission management, and session history.
 */

import { EventEmitter } from 'node:events';
import { AskUserQuestionInputSchema, safeParseToolInput } from '../schemas/tool-inputs.schema';
import { createLogger } from '../services/logger.service';
import {
  AutoApproveHandler,
  createAllowResponse,
  DeferredHandler,
  INTERACTIVE_TOOLS,
  ModeBasedHandler,
  type PermissionHandler,
} from './permissions';
import { ClaudeProcess, type ClaudeProcessOptions, type ExitResult } from './process';
import type { ControlResponseBody } from './protocol';
import { type HistoryMessage, SessionManager } from './session';
import type { ControlCancelRequest } from './types';
import {
  type AssistantMessage,
  type CanUseToolRequest,
  type ClaudeContentItem,
  type ClaudeJson,
  type ControlRequest,
  type HookCallbackRequest,
  type HooksConfig,
  type InitializeResponseData,
  isCanUseToolRequest,
  isHookCallbackRequest,
  type PermissionMode,
  type ResultMessage,
  type StreamEventMessage,
  type SystemCompactBoundaryMessage,
  type SystemHookResponseMessage,
  type SystemHookStartedMessage,
  type SystemInitMessage,
  type SystemMessage,
  type SystemStatusMessage,
  type ToolProgressMessage,
  type ToolUseContent,
  type ToolUseSummaryMessage,
  type UserMessage,
} from './types';

const logger = createLogger('claude-client');

// =============================================================================
// Types
// =============================================================================

/**
 * Options for creating a ClaudeClient.
 */
export interface ClaudeClientOptions {
  /** Working directory for the Claude CLI process */
  workingDir: string;
  /** Claude session ID to resume from */
  resumeClaudeSessionId?: string;
  /** Fork from the resumed session instead of continuing it */
  forkSession?: boolean;
  /** Model to use (overrides default) */
  model?: string;
  /** Additional system prompt text */
  systemPrompt?: string;
  /** Permission mode for tool execution */
  permissionMode?: PermissionMode;
  /** Custom permission handler (overrides permissionMode) */
  permissionHandler?: PermissionHandler;
  /** Hook configuration for PreToolUse and Stop hooks */
  hooks?: HooksConfig;
  /** Tools to disallow */
  disallowedTools?: string[];
  /** Initial prompt to send via -p flag */
  initialPrompt?: string;
  /** Include partial/streaming messages for real-time updates */
  includePartialMessages?: boolean;
  /** Enable extended thinking mode */
  thinkingEnabled?: boolean;
  /** Session ID for automatic process registration (optional) */
  sessionId?: string;
}

// =============================================================================
// ClaudeClient Class
// =============================================================================

/**
 * High-level client for interacting with Claude CLI.
 *
 * Provides a unified API combining process management, protocol handling,
 * permission management, and session history access.
 *
 * @example
 * ```typescript
 * const client = await ClaudeClient.create({
 *   workingDir: '/path/to/project',
 *   initialPrompt: 'Hello, Claude!',
 *   permissionMode: 'bypassPermissions',
 * });
 *
 * client.on('message', (msg) => console.log('Message:', msg));
 * client.on('tool_use', (tool) => console.log('Tool:', tool.name));
 * client.on('exit', (result) => console.log('Exited:', result.code));
 *
 * // Send follow-up messages
 * client.sendMessage('What files are in this directory?');
 *
 * // Send tool results
 * client.sendToolResult(toolUseId, { result: 'success' });
 * ```
 */
/**
 * Pending interactive tool request (e.g., AskUserQuestion).
 */
export interface PendingInteractiveRequest {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

export class ClaudeClient extends EventEmitter {
  private process: ClaudeProcess | null = null;
  private permissionHandler: PermissionHandler;
  private workingDir: string;
  /** Handler for interactive tools that require user input (AskUserQuestion, etc.) */
  private interactiveHandler: DeferredHandler;
  /** Store pending interactive requests to retrieve original input when responding */
  private pendingInteractiveRequests: Map<string, CanUseToolRequest> = new Map();
  /** Map protocol request_id to tool_use_id for cancel request handling */
  private protocolToToolRequestId: Map<string, string> = new Map();
  /** Track cancelled protocol request IDs to avoid sending deny response */
  private cancelledProtocolRequests: Set<string> = new Set();
  /** Track whether context compaction is in progress (toggle-based detection) */
  private isCompacting = false;

  private constructor(workingDir: string, permissionHandler: PermissionHandler) {
    super();
    this.workingDir = workingDir;
    this.permissionHandler = permissionHandler;
    this.interactiveHandler = new DeferredHandler({ timeout: 300_000 }); // 5 minute timeout

    // Forward interactive tool requests as events and store them for later
    this.interactiveHandler.on('permission_request', (request, requestId) => {
      // Store the request so we can retrieve the input (e.g., questions) when responding
      this.pendingInteractiveRequests.set(requestId, request);

      this.emit('interactive_request', {
        requestId,
        toolName: request.tool_name,
        toolUseId: request.tool_use_id,
        input: request.input,
      } as PendingInteractiveRequest);
    });

    // Clean up pendingInteractiveRequests when requests time out
    this.interactiveHandler.on('request_timeout', (requestId) => {
      this.pendingInteractiveRequests.delete(requestId);
    });
  }

  // ===========================================================================
  // Factory Method
  // ===========================================================================

  /**
   * Create and initialize a new ClaudeClient.
   *
   * @param options - Configuration options for the client
   * @returns Promise resolving to the initialized ClaudeClient
   * @throws Error if process spawn fails or initialization times out
   */
  static async create(options: ClaudeClientOptions): Promise<ClaudeClient> {
    // Determine the permission handler to use
    let permissionHandler: PermissionHandler;

    if (options.permissionHandler) {
      // Use provided handler
      permissionHandler = options.permissionHandler;
    } else if (options.permissionMode === 'bypassPermissions') {
      // Auto-approve everything
      permissionHandler = new AutoApproveHandler();
    } else {
      // Use mode-based handler with specified mode (defaults to 'default')
      permissionHandler = new ModeBasedHandler(options.permissionMode ?? 'default');
    }

    // Create the client
    const client = new ClaudeClient(options.workingDir, permissionHandler);

    // Build process options
    const processOptions: ClaudeProcessOptions = {
      workingDir: options.workingDir,
      resumeClaudeSessionId: options.resumeClaudeSessionId,
      forkSession: options.forkSession,
      model: options.model,
      systemPrompt: options.systemPrompt,
      permissionMode: options.permissionMode,
      hooks: options.hooks,
      disallowedTools: options.disallowedTools,
      initialPrompt: options.initialPrompt,
      includePartialMessages: options.includePartialMessages,
      thinkingEnabled: options.thinkingEnabled,
      sessionId: options.sessionId,
    };

    // Spawn the process
    client.process = await ClaudeProcess.spawn(processOptions);

    // Set up event forwarding
    client.setupEventForwarding();

    // Set up permission request handling
    client.setupPermissionHandling();

    return client;
  }

  // ===========================================================================
  // Message Sending
  // ===========================================================================

  /**
   * Send a user message to Claude.
   *
   * @param content - The message content to send (string or content array with images)
   */
  sendMessage(content: string | ClaudeContentItem[]): void {
    if (!this.process) {
      throw new Error('ClaudeClient not initialized');
    }
    // Status is automatically set to 'running' by the protocol's 'sending' event
    this.process.protocol.sendUserMessage(content);
  }

  /**
   * Send a tool result back to Claude.
   *
   * @param toolUseId - The tool_use_id from the tool_use request
   * @param result - The result data (string or object)
   * @param isError - Whether this result represents an error
   */
  sendToolResult(toolUseId: string, result: string | object, isError?: boolean): void {
    if (!this.process) {
      throw new Error('ClaudeClient not initialized');
    }

    const content = typeof result === 'string' ? result : JSON.stringify(result);

    // Send as a user message with tool_result content
    const userMessage = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: toolUseId,
            content,
            ...(isError && { is_error: true }),
          },
        ],
      },
    };

    // Send raw via protocol
    this.process.protocol.sendUserMessage(userMessage.message.content);
  }

  // ===========================================================================
  // Session Info
  // ===========================================================================

  /**
   * Get the Claude CLI session ID for the current conversation.
   * This ID is used to locate history in ~/.claude/projects/.
   *
   * @returns The Claude session ID or null if not yet available
   */
  getClaudeSessionId(): string | null {
    return this.process?.getClaudeSessionId() ?? null;
  }

  /**
   * Get the session history for the current conversation.
   *
   * @returns Promise resolving to an array of history messages
   */
  async getSessionHistory(): Promise<HistoryMessage[]> {
    const claudeSessionId = this.getClaudeSessionId();
    if (!claudeSessionId) {
      return [];
    }
    return await SessionManager.getHistory(claudeSessionId, this.workingDir);
  }

  /**
   * Get the initialize response data from the CLI.
   *
   * @returns The initialize response or null if not yet received
   */
  getInitializeResponse(): InitializeResponseData | null {
    return this.process?.getInitializeResponse() ?? null;
  }

  /**
   * Get the OS process ID.
   * Used for database tracking and orphan cleanup.
   *
   * @returns The PID or undefined if process not running
   */
  getPid(): number | undefined {
    return this.process?.getPid();
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Gracefully stop the Claude process.
   * Sends an interrupt signal and waits for graceful exit.
   */
  async stop(): Promise<void> {
    this.pendingInteractiveRequests.clear();
    this.interactiveHandler.cancelAll('Client stopping');
    if (this.process) {
      await this.process.interrupt();
    }
  }

  /**
   * Forcefully kill the Claude process.
   */
  kill(): void {
    this.pendingInteractiveRequests.clear();
    this.interactiveHandler.cancelAll('Client killed');
    if (this.process) {
      this.process.kill();
    }
  }

  /**
   * Check if the Claude process is still running (alive but may be idle).
   */
  isRunning(): boolean {
    return this.process?.isRunning() ?? false;
  }

  /**
   * Check if the Claude process is actively working (processing a request).
   * Returns true only when status is 'running', false for 'ready' (idle) or 'exited'.
   * Use this to determine if the UI should show a "thinking" indicator.
   */
  isWorking(): boolean {
    return this.process?.getStatus() === 'running';
  }

  // ===========================================================================
  // Interactive Tool Responses
  // ===========================================================================

  /**
   * Answer an AskUserQuestion request.
   * The answers object maps question text to selected option label(s).
   *
   * @param requestId - The request ID from the 'interactive_request' event
   * @param answers - Map of question text to selected answer(s)
   */
  answerQuestion(requestId: string, answers: Record<string, string | string[]>): void {
    // Retrieve the stored request to get the original questions
    const storedRequest = this.pendingInteractiveRequests.get(requestId);
    if (!storedRequest) {
      throw new Error(`No pending interactive request found with ID: ${requestId}`);
    }

    // Get questions from the stored request with validation
    const parsed = safeParseToolInput(
      AskUserQuestionInputSchema,
      storedRequest.input,
      'AskUserQuestion'
    );
    if (!parsed.success) {
      throw new Error(`Invalid AskUserQuestion input for request ID: ${requestId}`);
    }
    const questions = parsed.data.questions;

    // Clean up stored request
    this.pendingInteractiveRequests.delete(requestId);

    // Approve with both questions and answers (required by Claude CLI)
    this.interactiveHandler.approve(requestId, { questions, answers });
  }

  /**
   * Approve an interactive tool request (e.g., ExitPlanMode).
   * For AskUserQuestion, use answerQuestion instead.
   *
   * @param requestId - The request ID from the 'interactive_request' event
   */
  approveInteractiveRequest(requestId: string): void {
    // Retrieve the stored request to pass through the original input
    const storedRequest = this.pendingInteractiveRequests.get(requestId);
    if (!storedRequest) {
      throw new Error(`No pending interactive request found with ID: ${requestId}`);
    }

    // Clean up stored request
    this.pendingInteractiveRequests.delete(requestId);

    // Approve with the original input (pass it through unchanged)
    this.interactiveHandler.approve(requestId, storedRequest.input);
  }

  /**
   * Deny an interactive tool request.
   *
   * @param requestId - The request ID from the 'interactive_request' event
   * @param reason - The reason for denial
   */
  denyInteractiveRequest(requestId: string, reason: string): void {
    // Clean up stored request
    this.pendingInteractiveRequests.delete(requestId);
    this.interactiveHandler.deny(requestId, reason);
  }

  // ===========================================================================
  // Model and Thinking Control
  // ===========================================================================

  /**
   * Set the model for subsequent messages.
   *
   * @param model - Optional model name (undefined to use default)
   */
  async setModel(model?: string): Promise<void> {
    if (!this.process) {
      throw new Error('ClaudeClient not initialized');
    }
    await this.process.protocol.sendSetModel(model);
  }

  /**
   * Set the maximum thinking tokens for extended thinking mode.
   *
   * @param tokens - Maximum tokens for thinking (null to disable)
   */
  async setMaxThinkingTokens(tokens: number | null): Promise<void> {
    if (!this.process) {
      throw new Error('ClaudeClient not initialized');
    }
    await this.process.protocol.sendSetMaxThinkingTokens(tokens);
  }

  // ===========================================================================
  // Event Emitter Overloads (for TypeScript)
  // ===========================================================================

  override on(event: 'message', handler: (msg: AssistantMessage | UserMessage) => void): this;
  override on(event: 'tool_use', handler: (toolUse: ToolUseContent) => void): this;
  override on(event: 'stream', handler: (event: StreamEventMessage) => void): this;
  override on(event: 'tool_progress', handler: (event: ToolProgressMessage) => void): this;
  override on(event: 'tool_use_summary', handler: (event: ToolUseSummaryMessage) => void): this;
  override on(event: 'permission_request', handler: (req: ControlRequest) => void): this;
  override on(
    event: 'interactive_request',
    handler: (req: PendingInteractiveRequest) => void
  ): this;
  override on(event: 'result', handler: (result: ResultMessage) => void): this;
  override on(event: 'exit', handler: (result: ExitResult) => void): this;
  override on(event: 'error', handler: (error: Error) => void): this;
  override on(event: 'session_id', handler: (claudeSessionId: string) => void): this;
  override on(event: 'idle', handler: () => void): this;
  // System subtype events
  override on(event: 'system', handler: (msg: SystemMessage) => void): this;
  override on(event: 'system_init', handler: (msg: SystemInitMessage) => void): this;
  override on(event: 'system_status', handler: (msg: SystemStatusMessage) => void): this;
  override on(
    event: 'compact_boundary',
    handler: (msg: SystemCompactBoundaryMessage) => void
  ): this;
  override on(event: 'hook_started', handler: (msg: SystemHookStartedMessage) => void): this;
  override on(event: 'hook_response', handler: (msg: SystemHookResponseMessage) => void): this;
  override on(event: 'compacting_start', handler: () => void): this;
  override on(event: 'compacting_end', handler: () => void): this;
  override on(event: 'permission_cancelled', handler: (requestId: string) => void): this;
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter requires any[] for generic handler
  override on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  override emit(event: 'message', msg: AssistantMessage | UserMessage): boolean;
  override emit(event: 'tool_use', toolUse: ToolUseContent): boolean;
  override emit(event: 'stream', event_: StreamEventMessage): boolean;
  override emit(event: 'tool_progress', event_: ToolProgressMessage): boolean;
  override emit(event: 'tool_use_summary', event_: ToolUseSummaryMessage): boolean;
  override emit(event: 'permission_request', req: ControlRequest): boolean;
  override emit(event: 'interactive_request', req: PendingInteractiveRequest): boolean;
  override emit(event: 'result', result: ResultMessage): boolean;
  override emit(event: 'exit', result: ExitResult): boolean;
  override emit(event: 'error', error: Error): boolean;
  override emit(event: 'session_id', claudeSessionId: string): boolean;
  override emit(event: 'idle'): boolean;
  // System subtype events
  override emit(event: 'system', msg: SystemMessage): boolean;
  override emit(event: 'system_init', msg: SystemInitMessage): boolean;
  override emit(event: 'system_status', msg: SystemStatusMessage): boolean;
  override emit(event: 'compact_boundary', msg: SystemCompactBoundaryMessage): boolean;
  override emit(event: 'hook_started', msg: SystemHookStartedMessage): boolean;
  override emit(event: 'hook_response', msg: SystemHookResponseMessage): boolean;
  override emit(event: 'compacting_start'): boolean;
  override emit(event: 'compacting_end'): boolean;
  override emit(event: 'permission_cancelled', requestId: string): boolean;
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter requires any[] for generic emit
  override emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Set up event forwarding from ClaudeProcess to ClaudeClient.
   */
  private setupEventForwarding(): void {
    if (!this.process) {
      return;
    }

    // Forward messages with additional processing
    this.process.on('message', (msg: ClaudeJson) => this.handleProcessMessage(msg));

    // Forward session_id
    this.process.on('session_id', (claudeSessionId: string) => {
      this.emit('session_id', claudeSessionId);
    });

    // Forward exit
    this.process.on('exit', (result: ExitResult) => {
      this.emit('exit', result);
    });

    // Forward errors
    this.process.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // Forward idle (for message queue dispatch)
    this.process.on('idle', () => {
      this.emit('idle');
    });
  }

  /**
   * Handle a message from the ClaudeProcess.
   */
  private handleProcessMessage(msg: ClaudeJson): void {
    switch (msg.type) {
      case 'assistant':
        // End compaction if in progress (fallback for single-boundary case)
        if (this.isCompacting) {
          this.isCompacting = false;
          this.emit('compacting_end');
        }
        this.emit('message', msg);
        this.extractToolUseEvents(msg);
        break;
      case 'user':
        this.emit('message', msg);
        break;
      case 'result':
        this.emit('result', msg);
        break;
      case 'stream_event':
        this.emit('stream', msg);
        break;
      case 'system':
        this.handleSystemMessage(msg as SystemMessage);
        break;
      // SDK message types - forward as dedicated events
      case 'tool_progress':
        this.emit('tool_progress', msg);
        break;
      case 'tool_use_summary':
        this.emit('tool_use_summary', msg);
        break;
    }
  }

  /**
   * Handle system messages by subtype.
   */
  private handleSystemMessage(msg: SystemMessage): void {
    switch (msg.subtype) {
      case 'init':
        this.emit('system_init', msg as SystemInitMessage);
        break;
      case 'status':
        this.emit('system_status', msg as SystemStatusMessage);
        break;
      case 'compact_boundary':
        this.emit('compact_boundary', msg as SystemCompactBoundaryMessage);
        // Toggle-based compaction detection for start/end events
        if (!this.isCompacting) {
          this.isCompacting = true;
          this.emit('compacting_start');
        } else {
          this.isCompacting = false;
          this.emit('compacting_end');
        }
        break;
      case 'hook_started':
        this.emit('hook_started', msg as SystemHookStartedMessage);
        break;
      case 'hook_response':
        this.emit('hook_response', msg as SystemHookResponseMessage);
        break;
      default:
        // Forward unknown subtypes as generic system events
        this.emit('system', msg);
    }
  }

  /**
   * Extract and emit tool_use events from an assistant message.
   */
  private extractToolUseEvents(msg: AssistantMessage): void {
    const content = msg.message.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const item of content) {
      if (item.type === 'tool_use') {
        this.emit('tool_use', item);
      }
    }
  }

  /**
   * Set up permission request handling.
   */
  private setupPermissionHandling(): void {
    if (!this.process) {
      return;
    }

    this.process.protocol.on('control_request', async (controlRequest: ControlRequest) => {
      // Emit the permission request for visibility
      this.emit('permission_request', controlRequest);

      // Track mapping from protocol request_id to tool_use_id for interactive tools
      // This allows control_cancel to find the right request to cancel
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
        // Clean up mapping on successful response
        this.protocolToToolRequestId.delete(controlRequest.request_id);
        this.process?.protocol.sendControlResponse(controlRequest.request_id, response);
      } catch (error) {
        // Clean up mapping on error
        this.protocolToToolRequestId.delete(controlRequest.request_id);

        // Check if this request was cancelled - if so, don't send a deny response
        // The protocol states "No response is required" for control_cancel_request
        if (this.cancelledProtocolRequests.has(controlRequest.request_id)) {
          this.cancelledProtocolRequests.delete(controlRequest.request_id);
          logger.debug('Skipping deny response for cancelled request', {
            requestId: controlRequest.request_id,
          });
          return;
        }

        // On error, deny the request
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.process?.protocol.sendControlResponse(controlRequest.request_id, {
          behavior: 'deny',
          message: `Permission handler error: ${errorMessage}`,
        });
      }
    });

    // Handle cancel requests from CLI (e.g., when user interrupts during permission or question prompt)
    this.process.protocol.on('control_cancel', (cancelRequest: ControlCancelRequest) => {
      // Look up the tool_use_id from protocol request_id mapping
      // DeferredHandler and pendingInteractiveRequests use tool_use_id as key, not protocol request_id
      const toolUseId = this.protocolToToolRequestId.get(cancelRequest.request_id);
      const requestIdToCancel = toolUseId ?? cancelRequest.request_id;

      logger.debug('Control cancel received', {
        protocolRequestId: cancelRequest.request_id,
        toolUseId,
        requestIdToCancel,
      });

      // Mark request as cancelled BEFORE cancelling to prevent deny response
      // The control_request handler checks this set to avoid sending a response
      this.cancelledProtocolRequests.add(cancelRequest.request_id);

      // Cancel the deferred interactive handler's pending request
      this.interactiveHandler.cancel(requestIdToCancel, 'Request cancelled by CLI');

      // Clean up stored request and mapping
      const hadStoredRequest = this.pendingInteractiveRequests.has(requestIdToCancel);
      this.pendingInteractiveRequests.delete(requestIdToCancel);
      this.protocolToToolRequestId.delete(cancelRequest.request_id);

      logger.debug('Request cancelled cleanup', {
        requestIdToCancel,
        hadStoredRequest,
      });

      // Emit for forwarding to frontend (use tool_use_id which matches what frontend expects)
      this.emit('permission_cancelled', requestIdToCancel);
    });
  }

  /**
   * Handle a control request and return the appropriate response.
   */
  private async handleControlRequest(
    request: ControlRequest['request']
  ): Promise<ControlResponseBody> {
    if (isCanUseToolRequest(request)) {
      // Route interactive tools to the deferred handler to wait for user input
      if (INTERACTIVE_TOOLS.has(request.tool_name)) {
        return await this.interactiveHandler.onCanUseTool(request);
      }
      return await this.permissionHandler.onCanUseTool(request);
    }

    if (isHookCallbackRequest(request)) {
      return await this.handleHookCallback(request);
    }

    // Unknown request type - deny for security
    return {
      behavior: 'deny',
      message: `Unknown request subtype: ${(request as { subtype?: string }).subtype ?? 'undefined'}`,
    };
  }

  /**
   * Handle a hook callback request.
   */
  private async handleHookCallback(request: HookCallbackRequest): Promise<ControlResponseBody> {
    const hookEventName = request.input.hook_event_name;

    if (hookEventName === 'PreToolUse') {
      return await this.permissionHandler.onPreToolUseHook(request);
    }

    if (hookEventName === 'Stop') {
      return await this.permissionHandler.onStopHook(request);
    }

    // Unknown hook type - allow by default
    return createAllowResponse();
  }
}

// =============================================================================
// Re-exports
// =============================================================================

export * from './permissions';
export * from './process';
export * from './protocol';
export * from './registry';
export * from './session';
export * from './types';
