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
  ClaudeJsonSchema,
  type ControlCancelRequest,
  type ControlRequest,
  type ControlResponseData,
  type HooksConfig,
  type InitializeResponseData,
  InitializeResponseDataSchema,
  isControlCancelRequest,
  isControlRequest,
  isKeepAliveMessage,
  isStreamEventMessage,
  type KeepAliveMessage,
  type PermissionMode,
  type RewindFilesResponse,
  RewindFilesResponseSchema,
  type StreamEventMessage,
} from './types';

const logger = createLogger('protocol');

// =============================================================================
// Exported Types
// =============================================================================

/**
 * Pending request tracking for request/response correlation.
 * Generic type parameter allows type-safe response handling.
 */
export interface PendingRequest<T = unknown> {
  requestId: string;
  resolve: (response: T) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
  /** The subtype of the request, used to validate the response schema */
  requestSubtype?: string;
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
 *   protocol.sendControlResponse(req.request_id, { behavior: 'allow', updatedInput: {} });
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
  private pendingRequests: Map<string, PendingRequest<unknown>>;
  private rl: readline.Interface | null;
  private requestTimeout: number;
  private maxLineLength: number;
  private started: boolean;
  private drainPromise: Promise<void> | null;
  private drainReject: ((error: Error) => void) | null;
  private drainErrorHandler: ((error: Error) => void) | null;
  private drainHandler: (() => void) | null;
  private stdinErrorHandler: ((error: Error) => void) | null;
  private stdoutErrorHandler: ((error: Error) => void) | null;

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
    this.drainHandler = null;
    this.stdinErrorHandler = null;
    this.stdoutErrorHandler = null;
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
        requestSubtype: 'initialize',
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

    this.emit('sending'); // Notify listeners before sending (for status updates)
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

  /**
   * Send request to set the model.
   *
   * @param model - Optional model name to set (undefined to use default)
   * @returns Promise that resolves when the message is sent
   */
  async sendSetModel(model?: string): Promise<void> {
    const requestId = randomUUID();

    const message = {
      type: 'control_request' as const,
      request_id: requestId,
      request: {
        subtype: 'set_model' as const,
        ...(model !== undefined && { model }),
      },
    };

    await this.sendRaw(message);
  }

  /**
   * Send request to set max thinking tokens.
   *
   * @param tokens - Max thinking tokens (null to disable)
   * @returns Promise that resolves when the message is sent
   */
  async sendSetMaxThinkingTokens(tokens: number | null): Promise<void> {
    const requestId = randomUUID();

    const message = {
      type: 'control_request' as const,
      request_id: requestId,
      request: {
        subtype: 'set_max_thinking_tokens' as const,
        max_thinking_tokens: tokens,
      },
    };

    await this.sendRaw(message);
  }

  /**
   * Send request to rewind files to state before a user message.
   *
   * @param userMessageId - The UUID of the user message to rewind to
   * @param dryRun - If true, returns preview of files that would be reverted without making changes
   * @returns Promise resolving to the rewind files response (affected files list)
   */
  sendRewindFiles(userMessageId: string, dryRun?: boolean): Promise<RewindFilesResponse> {
    const requestId = randomUUID();

    const message = {
      type: 'control_request' as const,
      request_id: requestId,
      request: {
        subtype: 'rewind_files' as const,
        user_message_id: userMessageId,
        ...(dryRun !== undefined && { dry_run: dryRun }),
      },
    };

    return new Promise<RewindFilesResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Rewind files request timed out after ${this.requestTimeout}ms`));
      }, this.requestTimeout);

      this.pendingRequests.set(requestId, {
        requestId,
        resolve: resolve as (response: unknown) => void,
        reject,
        timeoutId,
        requestSubtype: 'rewind_files',
      });

      // Fire-and-forget the send - backpressure handled internally
      void this.sendRaw(message);
    });
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

    // Store references to error handlers for targeted cleanup
    this.stdinErrorHandler = (error: Error) => {
      this.emit('error', error);
    };
    this.stdin.on('error', this.stdinErrorHandler);

    this.stdoutErrorHandler = (error: Error) => {
      this.emit('error', error);
    };
    this.stdout.on('error', this.stdoutErrorHandler);
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

    // Remove only our error listeners to avoid affecting other listeners
    if (this.stdinErrorHandler) {
      this.stdin.removeListener('error', this.stdinErrorHandler);
      this.stdinErrorHandler = null;
    }
    if (this.stdoutErrorHandler) {
      this.stdout.removeListener('error', this.stdoutErrorHandler);
      this.stdoutErrorHandler = null;
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

        // Track drain handler so it can be removed on error
        this.drainHandler = () => {
          this.cleanupDrainHandlers();
          resolve();
        };

        // Handle stdin errors while waiting for drain to prevent memory leaks
        this.drainErrorHandler = (error: Error) => {
          this.cleanupDrainHandlers();
          reject(error);
        };

        this.stdin.once('drain', this.drainHandler);
        this.stdin.once('error', this.drainErrorHandler);
      });
      await this.drainPromise;
    }
  }

  /**
   * Clean up drain-related event handlers and state.
   */
  private cleanupDrainHandlers(): void {
    if (this.drainHandler) {
      this.stdin.removeListener('drain', this.drainHandler);
      this.drainHandler = null;
    }
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
      const rawData = JSON.parse(trimmed);
      const validationResult = ClaudeJsonSchema.safeParse(rawData);

      if (!validationResult.success) {
        logger.error('Invalid Claude JSON message', new Error('Schema validation failed'), {
          rawLine: trimmed.slice(0, 200),
          errors: validationResult.error.format(),
        });
        return;
      }

      parsed = validationResult.data as ClaudeJson;
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
    // Handle keep-alive messages - don't emit as regular message
    if (isKeepAliveMessage(msg)) {
      this.emit('keep_alive', msg);
      return;
    }

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
   * Safely format raw response for logging, handling undefined case.
   */
  private formatResponseForLogging(rawResponse: unknown): string {
    return rawResponse === undefined ? 'undefined' : JSON.stringify(rawResponse).slice(0, 500);
  }

  /**
   * Validate a control response payload against its schema.
   */
  private validateControlResponsePayload(
    rawResponse: unknown,
    requestSubtype: string | null | undefined,
    requestId: string
  ): unknown {
    if (requestSubtype === 'initialize') {
      const parseResult = InitializeResponseDataSchema.safeParse(rawResponse);
      if (!parseResult.success) {
        logger.error('Invalid initialize response payload', parseResult.error, {
          requestId,
          rawResponse: this.formatResponseForLogging(rawResponse),
        });
        throw new Error(
          `Invalid initialize response: ${parseResult.error.issues.map((i) => i.message).join(', ')}`
        );
      }
      return parseResult.data;
    }

    if (requestSubtype === 'rewind_files') {
      const parseResult = RewindFilesResponseSchema.safeParse(rawResponse);
      if (!parseResult.success) {
        logger.error('Invalid rewind files response payload', parseResult.error, {
          requestId,
          rawResponse: this.formatResponseForLogging(rawResponse),
        });
        throw new Error(
          `Invalid rewind files response: ${parseResult.error.issues.map((i) => i.message).join(', ')}`
        );
      }
      return parseResult.data;
    }

    // No validation schema for this request subtype - reject to prevent bypass
    const noSchemaError = new Error('Control response has no validation schema');
    logger.error('Control response has no validation schema', noSchemaError, {
      requestId,
      requestSubtype: requestSubtype ?? 'unknown',
      rawResponse: this.formatResponseForLogging(rawResponse),
    });
    throw noSchemaError;
  }

  /**
   * Handle a control response from the CLI.
   * Validates response payload against expected schema before resolving.
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

    if (!pending) {
      return;
    }

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingRequests.delete(requestId);

    const rawResponse = msg.response.response;

    try {
      const validatedResponse = this.validateControlResponsePayload(
        rawResponse,
        pending.requestSubtype,
        requestId
      );
      pending.resolve(validatedResponse);
    } catch (error) {
      // validateControlResponsePayload already logs detailed errors before throwing
      pending.reject(error instanceof Error ? error : new Error('Unknown validation error'));
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
  override on(event: 'keep_alive', handler: (msg: KeepAliveMessage) => void): this;
  override on(event: 'sending', handler: () => void): this;
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
  override emit(event: 'keep_alive', msg: KeepAliveMessage): boolean;
  override emit(event: 'sending'): boolean;
  override emit(event: 'error', error: Error): boolean;
  override emit(event: 'close'): boolean;
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter requires any[] for generic emit
  override emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}
