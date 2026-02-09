/**
 * Unified Claude CLI client.
 *
 * Provides a high-level API for interacting with the Claude CLI via
 * the streaming JSON protocol. Combines process management, protocol
 * handling, permission management, and session history.
 */

import { EventEmitter } from 'node:events';
import {
  ClaudePermissionCoordinator,
  type PendingInteractiveRequest,
} from './permission-coordinator';
import { AutoApproveHandler, ModeBasedHandler, type PermissionHandler } from './permissions';
import { ClaudeProcess, type ClaudeProcessOptions, type ExitResult } from './process';
import { type HistoryMessage, SessionManager } from './session';
import type {
  AssistantMessage,
  ClaudeContentItem,
  ClaudeJson,
  ControlRequest,
  HooksConfig,
  InitializeResponseData,
  PermissionMode,
  ResultMessage,
  RewindFilesResponse,
  StreamEventMessage,
  SystemCompactBoundaryMessage,
  SystemHookResponseMessage,
  SystemHookStartedMessage,
  SystemInitMessage,
  SystemMessage,
  SystemStatusMessage,
  ToolProgressMessage,
  ToolUseContent,
  ToolUseSummaryMessage,
  UserMessage,
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
  private workingDir: string;
  private permissionCoordinator: ClaudePermissionCoordinator;
  /** Track whether context compaction is in progress */
  private isCompacting = false;

  private constructor(workingDir: string, permissionCoordinator: ClaudePermissionCoordinator) {
    super();
    this.workingDir = workingDir;
    this.permissionCoordinator = permissionCoordinator;
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

    const permissionCoordinator = new ClaudePermissionCoordinator({
      permissionHandler,
      interactiveTimeoutMs: 300_000,
    });

    // Create the client
    const client = new ClaudeClient(options.workingDir, permissionCoordinator);

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
  async sendMessage(content: string | ClaudeContentItem[]): Promise<void> {
    if (!this.process) {
      throw new Error('ClaudeClient not initialized');
    }
    // Status is automatically set to 'running' by the protocol's 'sending' event
    await this.process.protocol.sendUserMessage(content);
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
    this.permissionCoordinator.stop('Client stopping');
    this.permissionCoordinator.unbind();
    if (this.process) {
      await this.process.interrupt();
    }
  }

  /**
   * Forcefully kill the Claude process.
   */
  kill(): void {
    this.permissionCoordinator.stop('Client killed');
    this.permissionCoordinator.unbind();
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

  /**
   * Check if context compaction is in progress.
   */
  isCompactingActive(): boolean {
    return this.isCompacting;
  }

  /**
   * Mark compaction as started and emit an event if needed.
   */
  startCompaction(): void {
    if (this.isCompacting) {
      return;
    }
    this.isCompacting = true;
    this.emit('compacting_start');
  }

  /**
   * Mark compaction as ended and emit an event if needed.
   */
  endCompaction(): void {
    if (!this.isCompacting) {
      return;
    }
    this.isCompacting = false;
    this.emit('compacting_end');
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
    this.permissionCoordinator.answerQuestion(requestId, answers);
  }

  /**
   * Approve an interactive tool request (e.g., ExitPlanMode).
   * For AskUserQuestion, use answerQuestion instead.
   *
   * @param requestId - The request ID from the 'interactive_request' event
   */
  approveInteractiveRequest(requestId: string): void {
    this.permissionCoordinator.approveInteractiveRequest(requestId);
  }

  /**
   * Deny an interactive tool request.
   *
   * @param requestId - The request ID from the 'interactive_request' event
   * @param reason - The reason for denial
   */
  denyInteractiveRequest(requestId: string, reason: string): void {
    this.permissionCoordinator.denyInteractiveRequest(requestId, reason);
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

  /**
   * Rewind files to the state before a user message was processed.
   *
   * @param userMessageId - The UUID of the user message to rewind to
   * @param dryRun - If true, returns preview of files that would be reverted without making changes
   * @returns Response containing list of affected files
   */
  rewindFiles(userMessageId: string, dryRun?: boolean): Promise<RewindFilesResponse> {
    if (!this.process) {
      return Promise.reject(new Error('ClaudeClient not initialized'));
    }
    return this.process.protocol.sendRewindFiles(userMessageId, dryRun);
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
  override on(event: string, handler: EventEmitterListener): this {
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
  override emit(event: string, ...args: EventEmitterEmitArgs): boolean {
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
        this.endCompaction();
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
        this.endCompaction();
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

    this.permissionCoordinator.bind(this.process.protocol);
    this.permissionCoordinator.on('permission_request', (request) => {
      this.emit('permission_request', request);
    });
    this.permissionCoordinator.on('interactive_request', (request) => {
      this.emit('interactive_request', request);
    });
    this.permissionCoordinator.on('permission_cancelled', (requestId) => {
      this.emit('permission_cancelled', requestId);
    });
  }
}

// =============================================================================
// Re-exports
// =============================================================================

export * from './permission-coordinator';
export * from './permissions';
export * from './process';
export * from './protocol';
export * from './protocol-io';
export * from './registry';
export * from './session';
export * from './types';

type EventEmitterListener = Parameters<EventEmitter['on']>[1];
type EventEmitterEmitArgs =
  Parameters<EventEmitter['emit']> extends [unknown, ...infer Args] ? Args : never;
