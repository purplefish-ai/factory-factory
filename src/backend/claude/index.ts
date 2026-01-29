/**
 * Unified Claude CLI client.
 *
 * Provides a high-level API for interacting with the Claude CLI via
 * the streaming JSON protocol. Combines process management, protocol
 * handling, permission management, and session history.
 */

import { EventEmitter } from 'node:events';
import { AutoApproveHandler, ModeBasedHandler, type PermissionHandler } from './permissions';
import { ClaudeProcess, type ClaudeProcessOptions, type ExitResult } from './process';
import type { ControlResponseBody } from './protocol';
import { type HistoryMessage, SessionManager } from './session';
import {
  type AssistantMessage,
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
  type ToolUseContent,
  type UserMessage,
} from './types';

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
export class ClaudeClient extends EventEmitter {
  private process: ClaudeProcess | null = null;
  private permissionHandler: PermissionHandler;
  private workingDir: string;

  private constructor(workingDir: string, permissionHandler: PermissionHandler) {
    super();
    this.workingDir = workingDir;
    this.permissionHandler = permissionHandler;
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
   * @param content - The message content to send
   */
  sendMessage(content: string): void {
    if (!this.process) {
      throw new Error('ClaudeClient not initialized');
    }
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
    if (this.process) {
      await this.process.interrupt();
    }
  }

  /**
   * Forcefully kill the Claude process.
   */
  kill(): void {
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
  // Event Emitter Overloads (for TypeScript)
  // ===========================================================================

  override on(event: 'message', handler: (msg: AssistantMessage | UserMessage) => void): this;
  override on(event: 'tool_use', handler: (toolUse: ToolUseContent) => void): this;
  override on(event: 'stream', handler: (event: StreamEventMessage) => void): this;
  override on(event: 'permission_request', handler: (req: ControlRequest) => void): this;
  override on(event: 'result', handler: (result: ResultMessage) => void): this;
  override on(event: 'exit', handler: (result: ExitResult) => void): this;
  override on(event: 'error', handler: (error: Error) => void): this;
  override on(event: 'session_id', handler: (claudeSessionId: string) => void): this;
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter requires any[] for generic handler
  override on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  override emit(event: 'message', msg: AssistantMessage | UserMessage): boolean;
  override emit(event: 'tool_use', toolUse: ToolUseContent): boolean;
  override emit(event: 'stream', event_: StreamEventMessage): boolean;
  override emit(event: 'permission_request', req: ControlRequest): boolean;
  override emit(event: 'result', result: ResultMessage): boolean;
  override emit(event: 'exit', result: ExitResult): boolean;
  override emit(event: 'error', error: Error): boolean;
  override emit(event: 'session_id', claudeSessionId: string): boolean;
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
  }

  /**
   * Handle a message from the ClaudeProcess.
   */
  private handleProcessMessage(msg: ClaudeJson): void {
    switch (msg.type) {
      case 'assistant':
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

      try {
        const response = await this.handleControlRequest(controlRequest.request);
        this.process?.protocol.sendControlResponse(controlRequest.request_id, response);
      } catch (error) {
        // On error, deny the request
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.process?.protocol.sendControlResponse(controlRequest.request_id, {
          behavior: 'deny',
          message: `Permission handler error: ${errorMessage}`,
        });
      }
    });
  }

  /**
   * Handle a control request and return the appropriate response.
   */
  private async handleControlRequest(
    request: ControlRequest['request']
  ): Promise<ControlResponseBody> {
    if (isCanUseToolRequest(request)) {
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
    return { behavior: 'allow' };
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
