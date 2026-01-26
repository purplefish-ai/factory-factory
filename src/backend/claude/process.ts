/**
 * Claude CLI process lifecycle management.
 *
 * Manages spawning and controlling a Claude CLI process with proper
 * initialization, session tracking, and graceful shutdown.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ClaudeProtocol } from './protocol.js';
import type { ClaudeJson, HooksConfig, InitializeResponseData, PermissionMode } from './types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Options for spawning a Claude CLI process.
 */
export interface ClaudeProcessOptions {
  /** Working directory for the Claude CLI process */
  workingDir: string;
  /** Session ID to resume from */
  resumeSessionId?: string;
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
}

/**
 * Result returned when the process exits.
 */
export interface ExitResult {
  /** Exit code (null if killed by signal) */
  code: number | null;
  /** Signal that killed the process (null if normal exit) */
  signal: NodeJS.Signals | null;
  /** Session ID extracted during the session */
  sessionId: string | null;
}

/**
 * Process lifecycle status.
 */
export type ProcessStatus = 'starting' | 'ready' | 'running' | 'exited';

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
  readonly protocol: ClaudeProtocol;

  /** Timeout for spawn/initialization in milliseconds */
  private static readonly SPAWN_TIMEOUT = 30_000;

  private process: ChildProcess;
  private sessionId: string | null = null;
  private status: ProcessStatus = 'starting';
  private initializeResponse: InitializeResponseData | null = null;
  private stderrBuffer: string[] = [];

  private constructor(process: ChildProcess, protocol: ClaudeProtocol) {
    super();
    this.process = process;
    this.protocol = protocol;
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

    // Verify stdio handles exist
    if (!(childProcess.stdin && childProcess.stdout && childProcess.stderr)) {
      childProcess.kill();
      throw new Error('Failed to create stdio pipes for Claude process');
    }

    const protocol = new ClaudeProtocol(childProcess.stdin, childProcess.stdout);
    const claudeProcess = new ClaudeProcess(childProcess, protocol);

    // Set up stderr collection for diagnostics
    childProcess.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      claudeProcess.stderrBuffer.push(text);
      // Keep buffer size reasonable
      if (claudeProcess.stderrBuffer.length > 100) {
        claudeProcess.stderrBuffer.shift();
      }
    });

    // Set up event forwarding
    claudeProcess.setupEventForwarding();

    // Set up process exit handling
    claudeProcess.setupExitHandling();

    // Start the protocol
    protocol.start();

    // Perform initialization sequence with timeout
    try {
      await ClaudeProcess.withTimeout(
        claudeProcess.initialize(options),
        ClaudeProcess.SPAWN_TIMEOUT,
        'Claude process spawn/initialization timed out'
      );
    } catch (error) {
      // Clean up on initialization failure
      claudeProcess.killProcessGroup();
      throw error;
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
   * Get the session ID extracted from the conversation.
   * Returns null until a message with session_id is received.
   */
  getSessionId(): string | null {
    return this.sessionId;
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
        sessionId: this.sessionId,
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
  override on(event: 'session_id', handler: (sessionId: string) => void): this;
  override on(event: 'exit', handler: (result: ExitResult) => void): this;
  override on(event: 'error', handler: (error: Error) => void): this;
  override on(event: 'status', handler: (status: ProcessStatus) => void): this;
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter requires any[] for generic handler
  override on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  override emit(event: 'message', msg: ClaudeJson): boolean;
  override emit(event: 'session_id', sessionId: string): boolean;
  override emit(event: 'exit', result: ExitResult): boolean;
  override emit(event: 'error', error: Error): boolean;
  override emit(event: 'status', status: ProcessStatus): boolean;
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter requires any[] for generic emit
  override emit(event: string, ...args: any[]): boolean {
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
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
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

    return args;
  }

  /**
   * Set up event forwarding from protocol to process.
   */
  private setupEventForwarding(): void {
    // Forward all messages
    this.protocol.on('message', (msg: ClaudeJson) => {
      this.emit('message', msg);
      this.extractSessionId(msg);

      // Update status based on message type
      if (msg.type === 'assistant' || msg.type === 'user') {
        this.setStatus('running');
      } else if (msg.type === 'result') {
        this.setStatus('ready');
      }
    });

    // Forward protocol errors
    this.protocol.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // Handle protocol close (stdout EOF)
    this.protocol.on('close', () => {
      // Process crash or unexpected close
      if (this.status !== 'exited') {
        const stderr = this.stderrBuffer.join('');
        this.emit('error', new Error(`Claude process closed unexpectedly. Stderr: ${stderr}`));
      }
    });
  }

  /**
   * Set up process exit handling.
   */
  private setupExitHandling(): void {
    this.process.on('exit', (code, signal) => {
      this.setStatus('exited');
      this.protocol.stop();

      const result: ExitResult = {
        code,
        signal: signal as NodeJS.Signals | null,
        sessionId: this.sessionId,
      };

      this.emit('exit', result);
    });

    this.process.on('error', (error) => {
      this.emit('error', error);
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
  private extractSessionId(msg: ClaudeJson): void {
    // Only extract once
    if (this.sessionId !== null) {
      return;
    }

    // Skip system and stream_event messages
    if (msg.type === 'system' || msg.type === 'stream_event') {
      return;
    }

    // Check for session_id on valid message types
    if (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result') {
      const sessionId = msg.session_id ?? (msg as { sessionId?: string }).sessionId;
      if (sessionId) {
        this.sessionId = sessionId;
        this.emit('session_id', sessionId);
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
}
