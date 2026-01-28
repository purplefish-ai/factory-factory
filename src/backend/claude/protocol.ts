/**
 * Bidirectional NDJSON protocol handler for Claude CLI.
 *
 * Handles communication with the Claude CLI process via stdin/stdout
 * using the streaming JSON protocol.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { createLogger } from '../services/logger.service';
import {
  type ClaudeContentItem,
  type ClaudeJson,
  type ControlCancelRequest,
  type ControlRequest,
  type ControlResponseData,
  type HooksConfig,
  type InitializeResponseData,
  isControlCancelRequest,
  isControlRequest,
  isStreamEventMessage,
  type PermissionMode,
  type StreamEventMessage,
} from './types';

const logger = createLogger('protocol');

// =============================================================================
// Exported Types
// =============================================================================

/**
 * Pending request tracking for request/response correlation.
 */
export interface PendingRequest {
  requestId: string;
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
}

/**
 * Options for configuring the protocol handler.
 */
export interface ClaudeProtocolOptions {
  /** Timeout for pending requests in milliseconds. Default: 60000ms */
  requestTimeout?: number;
  /** Maximum line length to accept from CLI. Default: 1MB */
  maxLineLength?: number;
}

/**
 * Body of a control response sent to the CLI.
 */
export type ControlResponseBody = ControlResponseData;

// =============================================================================
// Protocol Handler
// =============================================================================

/**
 * Bidirectional NDJSON protocol handler for Claude CLI.
 *
 * Handles communication with the Claude CLI process via stdin/stdout.
 * Emits events for incoming messages and provides methods for sending
 * outgoing messages.
 *
 * @example
 * ```typescript
 * const protocol = new ClaudeProtocol(process.stdin, process.stdout);
 *
 * protocol.on('message', (msg) => console.log('Received:', msg));
 * protocol.on('control_request', (req) => {
 *   // Handle permission request
 *   protocol.sendControlResponse(req.request_id, { behavior: 'allow' });
 * });
 *
 * protocol.start();
 * await protocol.sendInitialize();
 * protocol.sendUserMessage('Hello, Claude!');
 * ```
 */
export class ClaudeProtocol extends EventEmitter {
  private stdin: Writable;
  private stdout: Readable;
  private pendingRequests: Map<string, PendingRequest>;
  private rl: readline.Interface | null;
  private requestTimeout: number;
  private maxLineLength: number;
  private started: boolean;
  private drainPromise: Promise<void> | null;
  private drainReject: ((error: Error) => void) | null;
  private drainErrorHandler: ((error: Error) => void) | null;

  constructor(stdin: Writable, stdout: Readable, options?: ClaudeProtocolOptions) {
    super();
    this.stdin = stdin;
    this.stdout = stdout;
    this.pendingRequests = new Map();
    this.rl = null;
    this.requestTimeout = options?.requestTimeout ?? 60_000;
    this.maxLineLength = options?.maxLineLength ?? 1_000_000; // 1MB default
    this.started = false;
    this.drainPromise = null;
    this.drainReject = null;
    this.drainErrorHandler = null;
  }

  // ===========================================================================
  // SDK -> CLI Messages
  // ===========================================================================

  /**
   * Send initialize request to CLI and wait for response.
   *
   * @param hooks - Optional hook configuration for PreToolUse and Stop hooks
   * @returns Promise resolving to the initialize response data
   */
  sendInitialize(hooks?: HooksConfig): Promise<InitializeResponseData> {
    const requestId = randomUUID();

    const message = {
      type: 'control_request' as const,
      request_id: requestId,
      request: {
        subtype: 'initialize' as const,
        ...(hooks && { hooks }),
      },
    };

    return new Promise<InitializeResponseData>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Initialize request timed out after ${this.requestTimeout}ms`));
      }, this.requestTimeout);

      this.pendingRequests.set(requestId, {
        requestId,
        resolve: resolve as (response: unknown) => void,
        reject,
        timeoutId,
      });

      // Fire-and-forget the send - backpressure handled internally
      void this.sendRaw(message);
    });
  }

  /**
   * Send request to set permission mode.
   *
   * @param mode - The permission mode to set
   * @returns Promise that resolves when the message is sent
   */
  async sendSetPermissionMode(mode: PermissionMode): Promise<void> {
    const requestId = randomUUID();

    const message = {
      type: 'control_request' as const,
      request_id: requestId,
      request: {
        subtype: 'set_permission_mode' as const,
        mode,
      },
    };

    await this.sendRaw(message);
  }

  /**
   * Send a user message to the CLI.
   *
   * @param content - Either a string or an array of content items
   * @returns Promise that resolves when the message is sent
   */
  async sendUserMessage(content: string | ClaudeContentItem[]): Promise<void> {
    const message = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content,
      },
    };

    await this.sendRaw(message);
  }

  /**
   * Send a response to a control request from the CLI.
   *
   * @param requestId - The request_id from the control request
   * @param response - The response data
   * @returns Promise that resolves when the message is sent
   */
  async sendControlResponse(requestId: string, response: ControlResponseBody): Promise<void> {
    const message = {
      type: 'control_response' as const,
      response: {
        subtype: 'success' as const,
        request_id: requestId,
        response,
      },
    };

    await this.sendRaw(message);
  }

  /**
   * Send an interrupt signal to the CLI.
   *
   * @returns Promise that resolves when the message is sent
   */
  async sendInterrupt(): Promise<void> {
    const requestId = randomUUID();

    const message = {
      type: 'control_request' as const,
      request_id: requestId,
      request: {
        subtype: 'interrupt' as const,
      },
    };

    await this.sendRaw(message);
  }

  // ===========================================================================
  // Stream Processing
  // ===========================================================================

  /**
   * Start processing stdout from the CLI.
   *
   * Sets up line-buffered reading of stdout and emits events
   * for each parsed message.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    this.rl = readline.createInterface({
      input: this.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    this.rl.on('line', (line: string) => {
      this.processLine(line);
    });

    this.rl.on('close', () => {
      this.handleClose();
    });

    this.stdout.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  /**
   * Stop processing stdout and clean up resources.
   */
  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    // Clean up pending requests
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(new Error('Protocol stopped'));
    }
    this.pendingRequests.clear();

    // Clean up pending drain promise
    if (this.drainReject) {
      const reject = this.drainReject;
      this.cleanupDrainHandlers();
      reject(new Error('Protocol stopped'));
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Send a raw message to stdin as NDJSON with backpressure handling.
   *
   * If the write buffer is full, waits for drain before continuing.
   * This prevents memory exhaustion under high message volume.
   */
  private async sendRaw(message: unknown): Promise<void> {
    // Wait for any pending drain
    if (this.drainPromise) {
      await this.drainPromise;
    }

    // Check if stopped after waiting for drain
    if (!this.started) {
      throw new Error('Protocol stopped');
    }

    const line = `${JSON.stringify(message)}\n`;
    const canContinue = this.stdin.write(line);

    if (!canContinue) {
      // Buffer is full, wait for drain
      this.drainPromise = new Promise<void>((resolve, reject) => {
        this.drainReject = reject;

        const onDrain = () => {
          this.cleanupDrainHandlers();
          resolve();
        };

        // Handle stdin errors while waiting for drain to prevent memory leaks
        this.drainErrorHandler = (error: Error) => {
          this.cleanupDrainHandlers();
          reject(error);
        };

        this.stdin.once('drain', onDrain);
        this.stdin.once('error', this.drainErrorHandler);
      });
      await this.drainPromise;
    }
  }

  /**
   * Clean up drain-related event handlers and state.
   */
  private cleanupDrainHandlers(): void {
    if (this.drainErrorHandler) {
      this.stdin.removeListener('error', this.drainErrorHandler);
      this.drainErrorHandler = null;
    }
    this.drainPromise = null;
    this.drainReject = null;
  }

  /**
   * Process a single line of NDJSON output.
   */
  private processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    // Check line length to prevent memory exhaustion from pathological inputs
    if (trimmed.length > this.maxLineLength) {
      this.emit(
        'error',
        new Error(`Message exceeds max line length: ${trimmed.length} > ${this.maxLineLength}`)
      );
      return;
    }

    let parsed: ClaudeJson;
    try {
      parsed = JSON.parse(trimmed) as ClaudeJson;
    } catch (error) {
      // Log and skip malformed JSON
      logger.error('Failed to parse JSON', error as Error, {
        rawLine: trimmed.slice(0, 200),
      });
      return;
    }

    this.handleMessage(parsed);
  }

  /**
   * Handle a parsed message from the CLI.
   */
  private handleMessage(msg: ClaudeJson): void {
    // Always emit the raw message
    this.emit('message', msg);

    // Handle control requests
    if (isControlRequest(msg)) {
      this.emit('control_request', msg);
      return;
    }

    // Handle control cancel requests
    if (isControlCancelRequest(msg)) {
      this.handleControlCancel(msg);
      return;
    }

    // Handle stream events
    if (isStreamEventMessage(msg)) {
      this.emit('stream_event', msg);
      return;
    }

    // Check for control response (for initialize response)
    if (msg.type === 'control_response') {
      this.handleControlResponse(msg);
      return;
    }
  }

  /**
   * Handle a control response from the CLI.
   */
  private handleControlResponse(msg: {
    type: 'control_response';
    response: {
      subtype: 'success';
      request_id: string;
      response: unknown;
    };
  }): void {
    const requestId = msg.response.request_id;
    const pending = this.pendingRequests.get(requestId);

    if (pending) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      this.pendingRequests.delete(requestId);
      pending.resolve(msg.response.response);
    }
  }

  /**
   * Handle a control cancel request from the CLI.
   */
  private handleControlCancel(msg: ControlCancelRequest): void {
    const pending = this.pendingRequests.get(msg.request_id);

    if (pending) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      this.pendingRequests.delete(msg.request_id);
      pending.reject(new Error('Request cancelled by CLI'));
    }

    this.emit('control_cancel', msg);
  }

  /**
   * Handle stdout close event.
   */
  private handleClose(): void {
    logger.info('Protocol connection closed', {
      pendingRequests: this.pendingRequests.size,
      started: this.started,
    });

    // Clean up any pending requests
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    this.emit('close');
  }

  // ===========================================================================
  // Event Emitter Overloads (for TypeScript)
  // ===========================================================================

  override on(event: 'message', handler: (msg: ClaudeJson) => void): this;
  override on(event: 'control_request', handler: (req: ControlRequest) => void): this;
  override on(event: 'stream_event', handler: (event: StreamEventMessage) => void): this;
  override on(event: 'control_cancel', handler: (req: ControlCancelRequest) => void): this;
  override on(event: 'error', handler: (error: Error) => void): this;
  override on(event: 'close', handler: () => void): this;
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter requires any[] for generic handler
  override on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  override emit(event: 'message', msg: ClaudeJson): boolean;
  override emit(event: 'control_request', req: ControlRequest): boolean;
  override emit(event: 'stream_event', event_: StreamEventMessage): boolean;
  override emit(event: 'control_cancel', req: ControlCancelRequest): boolean;
  override emit(event: 'error', error: Error): boolean;
  override emit(event: 'close'): boolean;
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter requires any[] for generic emit
  override emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}
