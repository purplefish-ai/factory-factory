import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { CodexRpcResponse, CodexRpcServerRequest } from './codex-zod';
import {
  codexRpcNotificationEnvelopeSchema,
  codexRpcResponseSchema,
  codexRpcServerRequestSchema,
} from './codex-zod';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type CodexJsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export class CodexRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(params: { code: number; message: string; data?: unknown }) {
    super(params.message);
    this.code = params.code;
    this.data = params.data;
  }
}

export type CodexRpcClientOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStderr?: (line: string) => void;
  onNotification?: (notification: { method: string; params: unknown }) => void;
  onRequest?: (request: CodexRpcServerRequest) => void;
  onProtocolError?: (error: { reason: string; payload?: unknown }) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRequestErrorPayload(error: unknown): CodexJsonRpcError {
  if (isRecord(error) && typeof error.code === 'number' && typeof error.message === 'string') {
    return {
      code: error.code,
      message: error.message,
      ...(Object.hasOwn(error, 'data') ? { data: error.data } : {}),
    };
  }

  return {
    code: -32_003,
    message: error instanceof Error ? error.message : String(error),
  };
}

export class CodexRpcClient {
  private readonly options: CodexRpcClientOptions;
  private child: ChildProcess | null = null;
  private lineReader: ReadlineInterface | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(options: CodexRpcClientOptions) {
    this.options = options;
  }

  start(): void {
    if (this.child) {
      return;
    }

    const child = spawn('codex', ['app-server'], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.options.onStderr?.(chunk.toString());
    });

    const stdout = child.stdout;
    if (!stdout) {
      throw new Error('codex app-server stdout unavailable');
    }

    this.lineReader = createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY });
    this.lineReader.on('line', (line) => this.handleLine(line));

    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      this.lineReader?.close();
      this.lineReader = null;
      const reason = `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      this.rejectPending(new Error(reason));
    });

    child.on('error', (error) => {
      if (this.child === child) {
        this.child = null;
      }
      this.lineReader?.close();
      this.lineReader = null;
      this.rejectPending(error);
    });

    this.child = child;
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;

    this.lineReader?.close();
    this.lineReader = null;

    if (child.exitCode !== null) {
      return;
    }

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
        resolve();
      }, 2000);
      timeout.unref?.();
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async request<TResponse>(method: string, params?: unknown): Promise<TResponse> {
    const id = this.nextId;
    this.nextId += 1;

    const payload: Record<string, unknown> = {
      id,
      method,
      ...(typeof params === 'undefined' ? {} : { params }),
    };

    const responsePromise = new Promise<TResponse>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as TResponse),
        reject,
      });
    });

    try {
      this.write(payload);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.reject(error);
      }
    }
    return await responsePromise;
  }

  notify(method: string, params?: unknown): void {
    const payload: Record<string, unknown> = {
      method,
      ...(typeof params === 'undefined' ? {} : { params }),
    };

    this.write(payload);
  }

  respondSuccess(id: string | number | null, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: string | number | null, error: unknown): void {
    this.write({ id, error: toRequestErrorPayload(error) });
  }

  private rejectPending(error: unknown): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private write(payload: unknown): void {
    if (!this.child?.stdin) {
      throw new Error('codex app-server stdin unavailable');
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.options.onProtocolError?.({
        reason: 'invalid_json',
        payload: line,
      });
      return;
    }

    if (isRecord(parsed) && Object.hasOwn(parsed, 'id') && Object.hasOwn(parsed, 'method')) {
      this.handleServerRequest(parsed);
      return;
    }

    if (isRecord(parsed) && Object.hasOwn(parsed, 'method')) {
      this.handleNotification(parsed);
      return;
    }

    if (isRecord(parsed) && Object.hasOwn(parsed, 'id')) {
      this.handleResponse(parsed);
      return;
    }

    this.options.onProtocolError?.({
      reason: 'unrecognized_message',
      payload: parsed,
    });
  }

  private handleServerRequest(payload: unknown): void {
    const parsed = codexRpcServerRequestSchema.safeParse(payload);
    if (!parsed.success) {
      this.options.onProtocolError?.({
        reason: 'invalid_server_request',
        payload,
      });
      return;
    }

    this.options.onRequest?.(parsed.data);
  }

  private handleNotification(payload: unknown): void {
    const parsed = codexRpcNotificationEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      this.options.onProtocolError?.({
        reason: 'invalid_notification_envelope',
        payload,
      });
      return;
    }

    this.options.onNotification?.({ method: parsed.data.method, params: parsed.data.params });
  }

  private handleResponse(payload: unknown): void {
    const parsed = codexRpcResponseSchema.safeParse(payload);
    if (!parsed.success) {
      this.options.onProtocolError?.({
        reason: 'invalid_response',
        payload,
      });
      return;
    }

    this.resolvePending(parsed.data);
  }

  private resolvePending(response: CodexRpcResponse): void {
    if (typeof response.id !== 'number') {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(
        new CodexRequestError({
          code: response.error.code,
          message: response.error.message,
          data: response.error.data,
        })
      );
      return;
    }

    pending.resolve(response.result);
  }
}
