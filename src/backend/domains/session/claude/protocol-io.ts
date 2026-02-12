/**
 * Protocol IO adapter for Claude CLI.
 *
 * Provides a stable interface around ClaudeProtocol for dependency injection
 * and easier testing.
 */

import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { ClaudeProtocol, type ClaudeProtocolOptions, type ControlResponseBody } from './protocol';
import type {
  ClaudeContentItem,
  ClaudeJson,
  ControlCancelRequest,
  ControlRequest,
  HooksConfig,
  InitializeResponseData,
  KeepAliveMessage,
  PermissionMode,
  RewindFilesResponse,
  StreamEventMessage,
} from './types';

export interface ProtocolIOEvents {
  message: (msg: ClaudeJson) => void;
  control_request: (req: ControlRequest) => void;
  control_cancel: (req: ControlCancelRequest) => void;
  stream_event: (msg: StreamEventMessage) => void;
  keep_alive: (msg: KeepAliveMessage) => void;
  sending: () => void;
  error: (error: Error) => void;
  close: () => void;
}

export interface ProtocolIO {
  start(): void;
  stop(): void;
  sendInitialize(hooks?: HooksConfig): Promise<InitializeResponseData>;
  sendSetPermissionMode(mode: PermissionMode): Promise<void>;
  sendUserMessage(content: string | ClaudeContentItem[]): Promise<void>;
  sendControlResponse(requestId: string, response: ControlResponseBody): Promise<void>;
  sendSetModel(model?: string): Promise<void>;
  sendSetMaxThinkingTokens(tokens: number | null): Promise<void>;
  sendInterrupt(): Promise<void>;
  sendRewindFiles(userMessageId: string, dryRun?: boolean): Promise<RewindFilesResponse>;
  on<K extends keyof ProtocolIOEvents>(event: K, handler: ProtocolIOEvents[K]): this;
  removeListener<K extends keyof ProtocolIOEvents>(event: K, handler: ProtocolIOEvents[K]): this;
}

export class ClaudeProtocolIO extends EventEmitter implements ProtocolIO {
  private protocol: ClaudeProtocol;

  constructor(stdin: Writable, stdout: Readable, options?: ClaudeProtocolOptions) {
    super();
    this.protocol = new ClaudeProtocol(stdin, stdout, options);
    this.forwardEvents();
  }

  start(): void {
    this.protocol.start();
  }

  stop(): void {
    this.protocol.stop();
  }

  sendInitialize(hooks?: HooksConfig): Promise<InitializeResponseData> {
    return this.protocol.sendInitialize(hooks);
  }

  sendSetPermissionMode(mode: PermissionMode): Promise<void> {
    return this.protocol.sendSetPermissionMode(mode);
  }

  sendUserMessage(content: string | ClaudeContentItem[]): Promise<void> {
    return this.protocol.sendUserMessage(content);
  }

  sendControlResponse(requestId: string, response: ControlResponseBody): Promise<void> {
    return this.protocol.sendControlResponse(requestId, response);
  }

  sendSetModel(model?: string): Promise<void> {
    return this.protocol.sendSetModel(model);
  }

  sendSetMaxThinkingTokens(tokens: number | null): Promise<void> {
    return this.protocol.sendSetMaxThinkingTokens(tokens);
  }

  sendInterrupt(): Promise<void> {
    return this.protocol.sendInterrupt();
  }

  sendRewindFiles(userMessageId: string, dryRun?: boolean): Promise<RewindFilesResponse> {
    return this.protocol.sendRewindFiles(userMessageId, dryRun);
  }

  private forwardEvents(): void {
    this.protocol.on('message', (msg) => this.emit('message', msg));
    this.protocol.on('control_request', (req) => this.emit('control_request', req));
    this.protocol.on('control_cancel', (req) => this.emit('control_cancel', req));
    this.protocol.on('stream_event', (msg) => this.emit('stream_event', msg));
    this.protocol.on('keep_alive', (msg) => this.emit('keep_alive', msg));
    this.protocol.on('sending', () => this.emit('sending'));
    this.protocol.on('error', (error) => this.emit('error', error));
    this.protocol.on('close', () => this.emit('close'));
  }

  // =========================================================================
  // Event Emitter Overloads (for TypeScript)
  // =========================================================================

  override on<K extends keyof ProtocolIOEvents>(event: K, handler: ProtocolIOEvents[K]): this;
  override on(event: string, handler: (...args: unknown[]) => void): this {
    return super.on(event, handler);
  }

  override emit<K extends keyof ProtocolIOEvents>(
    event: K,
    ...args: Parameters<ProtocolIOEvents[K]>
  ): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override removeListener<K extends keyof ProtocolIOEvents>(
    event: K,
    handler: ProtocolIOEvents[K]
  ): this;
  override removeListener(event: string, handler: (...args: unknown[]) => void): this {
    return super.removeListener(event, handler);
  }
}
