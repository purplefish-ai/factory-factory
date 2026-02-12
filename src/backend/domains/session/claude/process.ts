/**
 * Claude CLI process lifecycle management.
 *
 * Manages spawning and controlling a Claude CLI process with proper
 * initialization, session tracking, graceful shutdown, resource monitoring,
 * and hung process detection.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { EventEmitterEmitArgs, EventEmitterListener } from '@/backend/lib/event-emitter-types';
import { createLogger } from '@/backend/services/logger.service';
import { CLAUDE_TIMEOUT_MS } from './constants';
import { ClaudeProcessMonitor, type ResourceMonitoringOptions } from './monitoring';
import { ClaudeProtocolIO } from './protocol-io';
import { processRegistry } from './registry';
import type { ClaudeJson, HooksConfig, InitializeResponseData, PermissionMode } from './types';
import type { ProcessStatus, ResourceUsage } from './types/process-types';

const logger = createLogger('claude-process');

export type { ResourceMonitoringOptions } from './monitoring';
export type { ProcessStatus, ResourceUsage } from './types/process-types';

export interface ClaudeProcessOptions {
  workingDir: string;
  resumeClaudeSessionId?: string;
  forkSession?: boolean;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  includePartialMessages?: boolean;
  disallowedTools?: string[];
  initialPrompt?: string;
  hooks?: HooksConfig;
  /** MCP server configuration JSON string (passed via --mcp-config) */
  mcpConfig?: string;
  thinkingEnabled?: boolean;
  resourceMonitoring?: ResourceMonitoringOptions;
  sessionId?: string;
}

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  claudeSessionId: string | null;
}

export class ClaudeProcess extends EventEmitter {
  readonly protocol: ClaudeProtocolIO;

  private process: ChildProcess;
  private claudeSessionId: string | null = null;
  private status: ProcessStatus = 'starting';
  private initializeResponse: InitializeResponseData | null = null;
  private stderrBuffer: string[] = [];
  private monitor: ClaudeProcessMonitor | null = null;
  private isIntentionallyStopping: boolean = false;
  private sessionId: string | null = null;

  private constructor(childProcess: ChildProcess, protocol: ClaudeProtocolIO, sessionId?: string) {
    super();
    this.process = childProcess;
    this.protocol = protocol;
    this.sessionId = sessionId ?? null;
  }

  static async spawn(options: ClaudeProcessOptions): Promise<ClaudeProcess> {
    const args = ClaudeProcess.buildArgs(options);

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
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      detached: true,
    });

    logger.info('Claude process spawned', { pid: childProcess.pid });

    if (!(childProcess.stdin && childProcess.stdout && childProcess.stderr)) {
      childProcess.kill();
      throw new Error('Failed to create stdio pipes for Claude process');
    }

    const protocol = new ClaudeProtocolIO(childProcess.stdin, childProcess.stdout);
    const claudeProcess = new ClaudeProcess(childProcess, protocol, options.sessionId);

    claudeProcess.setupExitHandling();

    const monitor = new ClaudeProcessMonitor(claudeProcess, options.resourceMonitoring);
    claudeProcess.attachMonitor(monitor);

    childProcess.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      logger.warn('Claude process stderr', { pid: childProcess.pid, stderr: text.trim() });
      claudeProcess.stderrBuffer.push(text);
      if (claudeProcess.stderrBuffer.length > 100) {
        claudeProcess.stderrBuffer.shift();
      }
    });

    claudeProcess.setupEventForwarding();
    protocol.start();

    try {
      await ClaudeProcess.withTimeout(
        claudeProcess.initialize(options),
        CLAUDE_TIMEOUT_MS.processSpawn,
        'Claude process spawn/initialization timed out'
      );
    } catch (error) {
      claudeProcess.isIntentionallyStopping = true;
      claudeProcess.killProcessGroup();
      throw error;
    }

    if (monitor.isEnabled()) {
      monitor.start();
    }

    if (options.sessionId) {
      processRegistry.register(options.sessionId, claudeProcess);
    }

    return claudeProcess;
  }

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

  getClaudeSessionId(): string | null {
    return this.claudeSessionId;
  }

  getStatus(): ProcessStatus {
    return this.status;
  }

  getInitializeResponse(): InitializeResponseData | null {
    return this.initializeResponse;
  }

  getPid(): number | undefined {
    return this.process.pid;
  }

  isRunning(): boolean {
    return this.status !== 'exited';
  }

  getResourceUsage(): ResourceUsage | null {
    return this.monitor?.getResourceUsage() ?? null;
  }

  getLastActivityAt(): number {
    return this.monitor?.getLastActivityAt() ?? 0;
  }

  getIdleTimeMs(): number {
    return this.monitor?.getIdleTimeMs() ?? 0;
  }

  async interrupt(): Promise<void> {
    if (this.status === 'exited') {
      return;
    }

    this.isIntentionallyStopping = true;
    await this.protocol.sendInterrupt();

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

    if (this.isRunning()) {
      this.killProcessGroup();
    }
  }

  kill(): void {
    if (this.status !== 'exited') {
      this.killProcessGroup();
    }
  }

  private killProcessGroup(): void {
    const pid = this.process.pid;
    if (!pid) {
      return;
    }

    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        this.process.kill('SIGKILL');
      } catch {
        // Process may already be dead
      }
    }
  }

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

  private static buildArgs(options: ClaudeProcessOptions): string[] {
    const args: string[] = [];

    if (options.initialPrompt) {
      args.push('-p', options.initialPrompt);
    }

    args.push('--output-format', 'stream-json');
    args.push('--input-format', 'stream-json');
    args.push('--permission-prompt-tool', 'stdio');
    args.push('--verbose');

    if (options.includePartialMessages) {
      args.push('--include-partial-messages');
    }

    if (options.resumeClaudeSessionId) {
      args.push('--resume', options.resumeClaudeSessionId);
      if (options.forkSession) {
        args.push('--fork-session');
      }
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    if (options.disallowedTools && options.disallowedTools.length > 0) {
      args.push('--disallowed-tools', options.disallowedTools.join(','));
    }

    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }

    if (options.mcpConfig) {
      args.push('--mcp-config', options.mcpConfig);
    }

    return args;
  }

  private setupEventForwarding(): void {
    this.protocol.on('sending', () => {
      this.setStatus('running');
    });

    this.protocol.on('keep_alive', () => {
      this.updateActivity();
    });

    this.protocol.on('message', (msg: ClaudeJson) => {
      this.emit('message', msg);
      this.extractClaudeSessionId(msg);
      this.updateActivity();

      if (msg.type === 'assistant' || msg.type === 'user') {
        this.setStatus('running');
      } else if (msg.type === 'result') {
        this.setStatus('ready');
        this.emit('idle');
      }
    });

    this.protocol.on('error', (error: Error) => {
      this.emit('error', error);
    });

    this.protocol.on('close', () => {
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

      if (this.sessionId) {
        processRegistry.unregister(this.sessionId);
      }

      const result: ExitResult = {
        code,
        signal: signal as NodeJS.Signals | null,
        claudeSessionId: this.claudeSessionId,
      };

      this.emit('exit', result);
    });
  }

  private async initialize(options: ClaudeProcessOptions): Promise<void> {
    this.initializeResponse = await this.protocol.sendInitialize(options.hooks);

    if (options.permissionMode) {
      await this.protocol.sendSetPermissionMode(options.permissionMode);
    }

    this.setStatus('ready');
  }

  private extractClaudeSessionId(msg: ClaudeJson): void {
    if (this.claudeSessionId !== null) {
      return;
    }

    if (msg.type === 'system' || msg.type === 'stream_event') {
      return;
    }

    if (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result') {
      const claudeSessionId = msg.session_id ?? (msg as { sessionId?: string }).sessionId;
      if (claudeSessionId) {
        this.claudeSessionId = claudeSessionId;
        this.emit('session_id', claudeSessionId);
      }
    }
  }

  private setStatus(status: ProcessStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit('status', status);
    }
  }

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
