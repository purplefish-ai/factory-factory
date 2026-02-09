/**
 * Claude CLI process lifecycle management.
 *
 * Manages spawning and controlling a Claude CLI process with proper
 * initialization, session tracking, graceful shutdown, resource monitoring,
 * and hung process detection.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createLogger } from '../services/logger.service';
import { CLAUDE_TIMEOUT_MS } from './constants';
import { ClaudeProcessMonitor, type ResourceMonitoringOptions } from './monitoring';
import { ClaudeProtocolIO } from './protocol-io';
import { registerProcess, unregisterProcess } from './registry';
import type { ClaudeJson, HooksConfig, InitializeResponseData, PermissionMode } from './types';

const logger = createLogger('claude-process');

// =============================================================================
// Types
// =============================================================================

// Import shared types (also re-exported for backwards compatibility)
import type { ProcessStatus, ResourceUsage } from './types/process-types';

export type { ResourceMonitoringOptions } from './monitoring';
export type { ProcessStatus, ResourceUsage } from './types/process-types';

/**
 * Options for spawning a Claude CLI process.
 */
export interface ClaudeProcessOptions {
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
  /** Include partial/streaming messages */
  includePartialMessages?: boolean;
  /** Tools to disallow */
  disallowedTools?: string[];
  /** Initial prompt to send via -p flag */
  initialPrompt?: string;
  /** Hook configuration for PreToolUse and Stop hooks */
  hooks?: HooksConfig;
  /** Enable extended thinking mode */
  thinkingEnabled?: boolean;
  /** Resource monitoring configuration */
  resourceMonitoring?: ResourceMonitoringOptions;
  /** Session ID for automatic process registration (optional) */
  sessionId?: string;
}

/**
 * Result returned when the process exits.
 */
export interface ExitResult {
  /** Exit code (null if killed by signal) */
  code: number | null;
  /** Signal that killed the process (null if normal exit) */
  signal: NodeJS.Signals | null;
  /** Claude CLI session ID extracted during the session (used for history in ~/.claude/projects/) */
  claudeSessionId: string | null;
}

// =============================================================================
// ClaudeProcess Class
// =============================================================================

/**
 * Manages the lifecycle of a Claude CLI process.
 *
 * Handles spawning, initialization, session ID extraction, and graceful shutdown.
 *
 * @example
 * ```typescript
 * const process = await ClaudeProcess.spawn({
 *   workingDir: '/path/to/project',
 *   initialPrompt: 'Hello, Claude!',
 *   permissionMode: 'bypassPermissions',
 * });
 *
 * process.on('message', (msg) => console.log('Message:', msg));
 * process.on('session_id', (id) => console.log('Session:', id));
 *
 * const result = await process.waitForExit();
 * console.log('Exit code:', result.code);
 * ```
 */
export class ClaudeProcess extends EventEmitter {
  readonly protocol: ClaudeProtocolIO;

  private process: ChildProcess;
  private claudeSessionId: string | null = null;
  private status: ProcessStatus = 'starting';
  private initializeResponse: InitializeResponseData | null = null;
  private stderrBuffer: string[] = [];

  // Resource monitoring state
  private monitor: ClaudeProcessMonitor | null = null;
  private isIntentionallyStopping: boolean = false;

  // Session ID for automatic registry (optional)
  private sessionId: string | null = null;

  private constructor(process: ChildProcess, protocol: ClaudeProtocolIO, sessionId?: string) {
    super();
    this.process = process;
    this.protocol = protocol;
    this.sessionId = sessionId ?? null;
  }

  // ===========================================================================
  // Static Factory Method
  // ===========================================================================

  /**
   * Spawn a new Claude CLI process.
   *
   * @param options - Configuration options for the process
   * @returns Promise resolving to the initialized ClaudeProcess
   * @throws Error if spawn fails or initialization times out
   */
  static async spawn(options: ClaudeProcessOptions): Promise<ClaudeProcess> {
    const args = ClaudeProcess.buildArgs(options);

    // Log the full command for debugging
    const fullCommand = ['claude', ...args]
      .map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))
      .join(' ');
    logger.info('Spawning Claude process - full command', {
      command: fullCommand,
      workingDir: options.workingDir,
    });
    logger.info('Spawning Claude process - options', {
      hasSystemPrompt: !!options.systemPrompt,
      systemPromptLength: options.systemPrompt?.length ?? 0,
      systemPromptPreview: options.systemPrompt?.slice(0, 500) ?? '(none)',
      resumeClaudeSessionId: options.resumeClaudeSessionId,
      model: options.model,
      permissionMode: options.permissionMode,
    });

    const childProcess = spawn('claude', args, {
      cwd: options.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure consistent output
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      // Create new process group for clean termination
      detached: true,
    });

    logger.info('Claude process spawned', { pid: childProcess.pid });

    // Verify stdio handles exist
    if (!(childProcess.stdin && childProcess.stdout && childProcess.stderr)) {
      childProcess.kill();
      throw new Error('Failed to create stdio pipes for Claude process');
    }

    const protocol = new ClaudeProtocolIO(childProcess.stdin, childProcess.stdout);
    const claudeProcess = new ClaudeProcess(childProcess, protocol, options.sessionId);

    // Set up process exit and error handling immediately to prevent unhandled events
    claudeProcess.setupExitHandling();

    const monitor = new ClaudeProcessMonitor(claudeProcess, options.resourceMonitoring);
    claudeProcess.attachMonitor(monitor);

    // Set up stderr collection for diagnostics
    childProcess.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      logger.warn('Claude process stderr', { pid: childProcess.pid, stderr: text.trim() });
      claudeProcess.stderrBuffer.push(text);
      // Keep buffer size reasonable
      if (claudeProcess.stderrBuffer.length > 100) {
        claudeProcess.stderrBuffer.shift();
      }
    });

    // Set up event forwarding
    claudeProcess.setupEventForwarding();

    // Start the protocol
    protocol.start();

    // Perform initialization sequence with timeout
    try {
      await ClaudeProcess.withTimeout(
        claudeProcess.initialize(options),
        CLAUDE_TIMEOUT_MS.processSpawn,
        'Claude process spawn/initialization timed out'
      );
    } catch (error) {
      // Mark as intentionally stopping to suppress error events from protocol close
      claudeProcess.isIntentionallyStopping = true;
      // Clean up on initialization failure
      claudeProcess.killProcessGroup();
      throw error;
    }

    if (monitor.isEnabled()) {
      monitor.start();
    }

    // Auto-register in the global registry if sessionId was provided
    if (options.sessionId) {
      registerProcess(options.sessionId, claudeProcess);
    }

    return claudeProcess;
  }

  /**
   * Helper to wrap a promise with a timeout.
   */
  private static withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  // ===========================================================================
  // Getters
  // ===========================================================================

  /**
   * Get the Claude CLI session ID extracted from the conversation.
   * This ID is used to locate history in ~/.claude/projects/.
   * Returns null until a message with session_id is received.
   */
  getClaudeSessionId(): string | null {
    return this.claudeSessionId;
  }

  /**
   * Get the current process status.
   */
  getStatus(): ProcessStatus {
    return this.status;
  }

  /**
   * Get the initialize response data.
   * Returns null until initialization completes.
   */
  getInitializeResponse(): InitializeResponseData | null {
    return this.initializeResponse;
  }

  /**
   * Get the OS process ID.
   * Used for database tracking and orphan cleanup.
   */
  getPid(): number | undefined {
    return this.process.pid;
  }

  /**
   * Check if the process is still running.
   */
  isRunning(): boolean {
    return this.status !== 'exited';
  }

  /**
   * Get the last recorded resource usage.
   * Returns null until first monitoring check completes.
   */
  getResourceUsage(): ResourceUsage | null {
    return this.monitor?.getResourceUsage() ?? null;
  }

  /**
   * Get the timestamp of last activity (message received).
   */
  getLastActivityAt(): number {
    return this.monitor?.getLastActivityAt() ?? 0;
  }

  /**
   * Get milliseconds since last activity.
   */
  getIdleTimeMs(): number {
    return this.monitor?.getIdleTimeMs() ?? 0;
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Send an interrupt signal to gracefully stop the current operation.
   * Waits up to 5 seconds for graceful exit before force killing.
   */
  async interrupt(): Promise<void> {
    if (this.status === 'exited') {
      return;
    }

    // Mark as intentionally stopping to suppress error events
    this.isIntentionallyStopping = true;

    // Send interrupt via protocol
    await this.protocol.sendInterrupt();

    // Wait for graceful exit with timeout
    const gracefulTimeout = 5000;
    const exitPromise = new Promise<void>((resolve) => {
      const onExit = () => {
        this.removeListener('exit', onExit);
        resolve();
      };
      this.on('exit', onExit);
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, gracefulTimeout);
    });

    await Promise.race([exitPromise, timeoutPromise]);

    // Force kill entire process group if still running
    if (this.isRunning()) {
      this.killProcessGroup();
    }
  }

  /**
   * Forcefully kill the process and its process group immediately.
   */
  kill(): void {
    if (this.status !== 'exited') {
      this.killProcessGroup();
    }
  }

  /**
   * Kill the entire process group using negative PGID.
   * Falls back to killing single process if group kill fails.
   */
  private killProcessGroup(): void {
    const pid = this.process.pid;
    if (!pid) {
      return;
    }

    try {
      // Kill entire process group using negative PID
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Fallback to killing single process
      try {
        this.process.kill('SIGKILL');
      } catch {
        // Process may already be dead
      }
    }
  }

  /**
   * Wait for the process to exit.
   *
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise resolving to the exit result
   * @throws Error if timeout is reached
   */
  waitForExit(timeoutMs?: number): Promise<ExitResult> {
    if (this.status === 'exited') {
      return Promise.resolve({
        code: this.process.exitCode,
        signal: this.process.signalCode as NodeJS.Signals | null,
        claudeSessionId: this.claudeSessionId,
      });
    }

    return new Promise<ExitResult>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | undefined;

      const onExit = (result: ExitResult) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve(result);
      };

      this.once('exit', onExit);

      if (timeoutMs !== undefined) {
        timeoutId = setTimeout(() => {
          this.removeListener('exit', onExit);
          reject(new Error(`Process did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  // ===========================================================================
  // Event Emitter Overloads
  // ===========================================================================

  override on(event: 'message', handler: (msg: ClaudeJson) => void): this;
  override on(event: 'session_id', handler: (claudeSessionId: string) => void): this;
  override on(event: 'exit', handler: (result: ExitResult) => void): this;
  override on(event: 'error', handler: (error: Error) => void): this;
  override on(event: 'status', handler: (status: ProcessStatus) => void): this;
  override on(event: 'idle', handler: () => void): this;
  override on(
    event: 'resource_exceeded',
    handler: (data: { type: 'memory' | 'cpu'; value: number }) => void
  ): this;
  override on(
    event: 'hung_warning',
    handler: (data: { lastActivity: number; idleTimeMs: number; timeoutMs: number }) => void
  ): this;
  override on(event: 'hung_process', handler: (data: { lastActivity: number }) => void): this;
  override on(event: 'resource_usage', handler: (usage: ResourceUsage) => void): this;
  override on(event: string, handler: EventEmitterListener): this {
    return super.on(event, handler);
  }

  override emit(event: 'message', msg: ClaudeJson): boolean;
  override emit(event: 'session_id', claudeSessionId: string): boolean;
  override emit(event: 'exit', result: ExitResult): boolean;
  override emit(event: 'error', error: Error): boolean;
  override emit(event: 'status', status: ProcessStatus): boolean;
  override emit(event: 'idle'): boolean;
  override emit(
    event: 'resource_exceeded',
    data: { type: 'memory' | 'cpu'; value: number }
  ): boolean;
  override emit(
    event: 'hung_warning',
    data: { lastActivity: number; idleTimeMs: number; timeoutMs: number }
  ): boolean;
  override emit(event: 'hung_process', data: { lastActivity: number }): boolean;
  override emit(event: 'resource_usage', usage: ResourceUsage): boolean;
  override emit(event: string, ...args: EventEmitterEmitArgs): boolean {
    return super.emit(event, ...args);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Build CLI arguments from options.
   */
  private static buildArgs(options: ClaudeProcessOptions): string[] {
    const args: string[] = [];

    // Initial prompt (required for non-interactive mode)
    if (options.initialPrompt) {
      args.push('-p', options.initialPrompt);
    }

    // Required flags for streaming JSON protocol
    args.push('--output-format', 'stream-json');
    args.push('--input-format', 'stream-json');
    args.push('--permission-prompt-tool', 'stdio');
    args.push('--verbose');

    // Optional: include partial messages for streaming deltas
    if (options.includePartialMessages) {
      args.push('--include-partial-messages');
    }

    // Session management
    if (options.resumeClaudeSessionId) {
      args.push('--resume', options.resumeClaudeSessionId);
      if (options.forkSession) {
        args.push('--fork-session');
      }
    }

    // Model override
    if (options.model) {
      args.push('--model', options.model);
    }

    // System prompt addition
    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    // Disallowed tools
    if (options.disallowedTools && options.disallowedTools.length > 0) {
      args.push('--disallowed-tools', options.disallowedTools.join(','));
    }

    // Permission mode - must be set via CLI args to be active before initial prompt
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }

    return args;
  }

  /**
   * Set up event forwarding from protocol to process.
   */
  private setupEventForwarding(): void {
    // Mark as working when sending a user message (prevents race condition
    // where another message could be dispatched before Claude responds)
    this.protocol.on('sending', () => {
      this.setStatus('running');
    });

    // Keep-alive indicates the CLI is still alive, so treat it as activity.
    this.protocol.on('keep_alive', () => {
      this.updateActivity();
    });

    // Forward all messages
    this.protocol.on('message', (msg: ClaudeJson) => {
      this.emit('message', msg);
      this.extractClaudeSessionId(msg);
      this.updateActivity(); // Track activity for hung detection

      // Update status based on message type
      if (msg.type === 'assistant' || msg.type === 'user') {
        this.setStatus('running');
      } else if (msg.type === 'result') {
        this.setStatus('ready');
        // Emit idle event to signal queue can dispatch next message
        this.emit('idle');
      }
    });

    // Forward protocol errors
    this.protocol.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // Handle protocol close (stdout EOF)
    this.protocol.on('close', () => {
      // Only log warning and emit error if not intentionally stopping and not already exited
      if (this.status !== 'exited' && !this.isIntentionallyStopping) {
        logger.warn('Claude protocol closed unexpectedly', {
          pid: this.process.pid,
          status: this.status,
          claudeSessionId: this.claudeSessionId,
        });
        const stderr = this.stderrBuffer.join('');
        logger.error('Claude process closed unexpectedly', {
          pid: this.process.pid,
          status: this.status,
          stderr: stderr || '(empty)',
          stderrBufferLength: this.stderrBuffer.length,
        });
        this.emit('error', new Error(`Claude process closed unexpectedly. Stderr: ${stderr}`));
      }
    });
  }

  /**
   * Set up process exit and error handling.
   */
  private setupExitHandling(): void {
    this.process.on('error', (error) => {
      logger.error('Claude process error event', {
        pid: this.process.pid,
        error: error.message,
        sessionId: this.sessionId,
      });
      this.emit('error', error);
    });

    this.process.on('exit', (code, signal) => {
      const stderr = this.stderrBuffer.join('');
      logger.info('Claude process exited', {
        pid: this.process.pid,
        code,
        signal,
        claudeSessionId: this.claudeSessionId,
        stderr: stderr || '(empty)',
      });

      this.setStatus('exited');
      this.protocol.stop();
      this.monitor?.stop();

      // Auto-unregister from the global registry if sessionId was provided
      if (this.sessionId) {
        unregisterProcess(this.sessionId);
      }

      const result: ExitResult = {
        code,
        signal: signal as NodeJS.Signals | null,
        claudeSessionId: this.claudeSessionId,
      };

      this.emit('exit', result);
    });
  }

  /**
   * Perform the initialization sequence.
   */
  private async initialize(options: ClaudeProcessOptions): Promise<void> {
    // Send initialize request
    this.initializeResponse = await this.protocol.sendInitialize(options.hooks);

    // Set permission mode if specified
    if (options.permissionMode) {
      await this.protocol.sendSetPermissionMode(options.permissionMode);
    }

    // Update status to ready
    this.setStatus('ready');
  }

  /**
   * Extract session ID from a message.
   * Session ID appears on assistant, user, tool_use, tool_result, or result messages.
   * Skip system and stream_event messages.
   */
  private extractClaudeSessionId(msg: ClaudeJson): void {
    // Only extract once
    if (this.claudeSessionId !== null) {
      return;
    }

    // Skip system and stream_event messages
    if (msg.type === 'system' || msg.type === 'stream_event') {
      return;
    }

    // Check for session_id on valid message types
    if (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result') {
      const claudeSessionId = msg.session_id ?? (msg as { sessionId?: string }).sessionId;
      if (claudeSessionId) {
        this.claudeSessionId = claudeSessionId;
        this.emit('session_id', claudeSessionId);
      }
    }
  }

  /**
   * Update status and emit status event.
   */
  private setStatus(status: ProcessStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit('status', status);
    }
  }

  /**
   * Update last activity timestamp and reset warning state.
   */
  private updateActivity(): void {
    this.monitor?.recordActivity();
  }

  private attachMonitor(monitor: ClaudeProcessMonitor): void {
    this.monitor = monitor;

    monitor.on('resource_usage', (usage) => this.emit('resource_usage', usage));
    monitor.on('resource_exceeded', (data) => this.emit('resource_exceeded', data));
    monitor.on('hung_warning', (data) => this.emit('hung_warning', data));
    monitor.on('hung_process', (data) => this.emit('hung_process', data));
  }
}
type EventEmitterListener = Parameters<EventEmitter['on']>[1];
type EventEmitterEmitArgs =
  Parameters<EventEmitter['emit']> extends [unknown, ...infer Args] ? Args : never;
