import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { type Mock, vi } from 'vitest';
import * as acpClientFactory from './acp-client-factory';
import type { AcpStartupSignal } from './acp-runtime-contracts';
import type { AcpRuntimeEventHandlers } from './acp-runtime-events';
import type { AcpClientOptions } from './types';

const hoistedMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  initialize: vi.fn(),
  loadSession: vi.fn(),
  newSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
  ndJsonStream: vi.fn(),
  connections: [] as Array<{
    toClient: (agent: unknown) => unknown;
    stream: unknown;
  }>,
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

export const mocks: {
  spawn: Mock;
  initialize: Mock;
  loadSession: Mock;
  newSession: Mock;
  setSessionConfigOption: Mock;
  ndJsonStream: Mock;
  connections: Array<{ toClient: (agent: unknown) => unknown; stream: unknown }>;
  logger: { info: Mock; debug: Mock; warn: Mock; error: Mock };
} = hoistedMocks;

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => hoistedMocks.spawn(...args),
}));

vi.mock('@agentclientprotocol/sdk/unstable', () => ({
  ndJsonStream: (...args: unknown[]) => hoistedMocks.ndJsonStream(...args),
  PROTOCOL_VERSION: 1,
}));

vi.mock('./acp-connection', () => ({
  createAcpConnection: (handler: unknown, stream: unknown) => {
    hoistedMocks.connections.push({ toClient: () => handler, stream });
    return {
      initialize: hoistedMocks.initialize,
      loadSession: hoistedMocks.loadSession,
      newSession: hoistedMocks.newSession,
      setSessionConfigOption: hoistedMocks.setSessionConfigOption,
    };
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => hoistedMocks.logger,
  getCurrentProcessEnv: () => ({ FROM_DEFAULT_PROVIDER: 'yes' }),
}));

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));
vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

type MockChildProcess = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
};

type RejectableSignal = AcpStartupSignal & { reject(error: Error): void };

export const CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    type: 'select' as const,
    category: 'model',
    currentValue: 'sonnet',
    options: [{ value: 'sonnet', name: 'Sonnet' }],
  },
  {
    id: 'mode',
    name: 'Mode',
    type: 'select' as const,
    category: 'mode',
    currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }],
  },
];

export function createMockChildProcess(options?: { exitAfterSigterm?: boolean }): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.pid = 12_345;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killed = signal !== undefined;
    if (signal === 'SIGTERM' && options?.exitAfterSigterm) {
      queueMicrotask(() => {
        child.signalCode = 'SIGTERM';
        child.emit('close', null, 'SIGTERM');
      });
    }
    if (signal === 'SIGKILL') {
      child.signalCode = 'SIGKILL';
      child.emit('close', null, 'SIGKILL');
    }
    return true;
  });
  return child;
}

export function createSignal(): RejectableSignal {
  let rejectSignal!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectSignal = reject;
  });
  return { promise, dispose: vi.fn(), reject: rejectSignal };
}

export function createDeferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

export function defaultOptions(overrides?: Partial<AcpClientOptions>): AcpClientOptions {
  return {
    provider: 'CLAUDE',
    workingDir: tmpdir(),
    sessionId: 'log-session-1',
    ...overrides,
  };
}

export function defaultHandlers(): AcpRuntimeEventHandlers {
  return {
    onRuntimeError: vi.fn(),
    onAcpEvent: vi.fn(),
    onAcpLog: vi.fn(),
  };
}

export function createParams(overrides?: {
  options?: AcpClientOptions;
  handlers?: AcpRuntimeEventHandlers;
  shutdownSignal?: AcpStartupSignal;
  stopSignal?: AcpStartupSignal;
  installed?: boolean;
}) {
  return {
    sessionId: 'session-1',
    options: overrides?.options ?? defaultOptions(),
    handlers: overrides?.handlers ?? defaultHandlers(),
    metadata: {
      incarnationId: 'incarnation-1',
      purpose: overrides?.options?.purpose ?? ('active' as const),
      installed: overrides?.installed ?? false,
    },
    shutdownSignal: overrides?.shutdownSignal ?? createSignal(),
    stopSignal: overrides?.stopSignal ?? createSignal(),
    shouldDispatchRuntimeError: vi.fn(() => true),
  };
}

export function setupSuccessfulSpawn(
  child = createMockChildProcess(),
  agentCapabilities: Record<string, unknown> = {}
): MockChildProcess {
  hoistedMocks.spawn.mockReturnValue(child);
  hoistedMocks.initialize.mockResolvedValue({
    protocolVersion: 1,
    agentCapabilities,
    agentInfo: { name: 'test-adapter' },
  });
  hoistedMocks.newSession.mockResolvedValue({
    sessionId: 'provider-session-new',
    configOptions: CONFIG_OPTIONS,
  });
  hoistedMocks.loadSession.mockResolvedValue({ configOptions: CONFIG_OPTIONS });
  return child;
}

export function resetAcpClientFactoryMocks(): void {
  vi.clearAllMocks();
  mocks.connections.length = 0;
  mocks.ndJsonStream.mockReturnValue({
    writable: {},
    readable: { pipeThrough: () => ({}) },
  });
}

export const AcpClientFactory = acpClientFactory.AcpClientFactory;
