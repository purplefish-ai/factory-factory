import type { SessionDeltaEvent } from '@/shared/claude';

export type CodexManagerState = 'stopped' | 'starting' | 'ready' | 'degraded' | 'unavailable';

export type CodexUnavailableReason =
  | 'missing_api_key'
  | 'spawn_failed'
  | 'handshake_failed'
  | 'process_exited';

export interface CodexManagerStatus {
  state: CodexManagerState;
  unavailableReason: CodexUnavailableReason | null;
  pid: number | null;
  startedAt: string | null;
  restartCount: number;
  activeSessionCount: number;
}

export type CodexRequestId = string | number;

export interface CodexTransportRequest {
  id: CodexRequestId;
  method: string;
  params?: unknown;
}

export interface CodexTransportNotification {
  method: string;
  params?: unknown;
}

export interface CodexTransportError {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexTransportResponse {
  id: CodexRequestId;
  result?: unknown;
  error?: CodexTransportError;
}

export type CodexTransportInbound =
  | CodexTransportNotification
  | CodexTransportResponse
  | CodexTransportRequest;

export interface CodexManagerNotificationEvent {
  sessionId: string;
  threadId: string;
  method: string;
  params: unknown;
}

export interface CodexManagerServerRequestEvent {
  sessionId: string;
  threadId: string;
  method: string;
  params: unknown;
  requestId: CodexRequestId;
  canonicalRequestId: string;
}

export interface CodexManagerHandlers {
  onNotification?: (event: CodexManagerNotificationEvent) => void;
  onServerRequest?: (event: CodexManagerServerRequestEvent) => void;
  onStatusChanged?: (status: CodexManagerStatus) => void;
  onSessionDelta?: (sessionId: string, event: SessionDeltaEvent) => void;
}

export interface CodexPendingInteractiveRequest {
  sessionId: string;
  threadId: string;
  requestId: string;
  serverRequestId: CodexRequestId;
  method: string;
  params: Record<string, unknown>;
}

export interface CodexThreadMappingStore {
  getMappedThreadId(sessionId: string): Promise<string | null>;
  setMappedThreadId(sessionId: string, threadId: string): Promise<void>;
  clearMappedThreadId(sessionId: string): Promise<void>;
}

export interface CodexRequestOptions {
  timeoutMs?: number;
  threadId?: string;
}

export interface CodexProcessFactory {
  spawn(
    command: string,
    args: string[]
  ): {
    pid?: number;
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    stdin: NodeJS.WritableStream;
    on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
    kill(signal?: NodeJS.Signals): boolean;
  };
}
