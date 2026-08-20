import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import { vi } from 'vitest';
import { SUBAGENTS_CAPABILITY_META_KEY } from '@/shared/acp-protocol/subagents';
import { AcpProcessHandle } from './acp-process-handle';
import type { AcpRuntimeEventHandlers } from './acp-runtime-events';
import type { AcpRuntimeManager } from './acp-runtime-manager';
import type { AcpClientOptions } from './types';

function unsafeCoerce<T>(value: unknown): T {
  return value as T;
}

export type MockChildProcess = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
};

export function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.pid = 12_345;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = vi.fn((signal?: string) => {
    if (signal) {
      child.killed = true;
    }
    if (signal === 'SIGKILL') {
      child.exitCode = 137;
      child.emit('exit', 137, 'SIGKILL');
    }
    return true;
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}

export function exitChildAfterSigterm(child: MockChildProcess): void {
  child.kill = vi.fn((signal?: string) => {
    if (signal === 'SIGTERM') {
      queueMicrotask(() => {
        child.killed = true;
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
      });
    }
    return true;
  });
}

export function exitChildWithCode(child: MockChildProcess): void {
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  });
}

export function markChildKilledOnSignal(child: MockChildProcess): void {
  child.kill = vi.fn((signal?: string) => {
    if (signal) {
      child.killed = true;
    }
    return true;
  });
}

export function createTestProcessHandle(params?: {
  provider?: string;
  providerSessionId?: string;
  agentCapabilities?: Record<string, unknown>;
  connection?: Partial<ClientSideConnection>;
}): AcpProcessHandle {
  return new AcpProcessHandle({
    connection: unsafeCoerce<ClientSideConnection>(params?.connection ?? {}),
    child: unsafeCoerce<ChildProcess>(createMockChildProcess()),
    provider: params?.provider ?? 'CODEX',
    providerSessionId: params?.providerSessionId ?? 'provider-session-1',
    agentCapabilities: params?.agentCapabilities ?? {},
  });
}

export function defaultHandlers(): AcpRuntimeEventHandlers {
  return {
    onSessionId: vi.fn().mockResolvedValue(undefined),
    onExit: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    onAcpEvent: vi.fn(),
  };
}

export function createTestClient(
  manager: AcpRuntimeManager,
  params?: {
    sessionId?: string;
    options?: AcpClientOptions;
    handlers?: AcpRuntimeEventHandlers;
    context?: ReturnType<typeof defaultContext>;
  }
) {
  return manager.getOrCreateClient(
    params?.sessionId ?? 'session-1',
    params?.options ?? defaultOptions(),
    params?.handlers ?? defaultHandlers(),
    params?.context ?? defaultContext()
  );
}

export function defaultOptions(): AcpClientOptions {
  return {
    provider: 'CLAUDE',
    workingDir: '/tmp/workspace',
    sessionId: 'test-session-1',
  };
}

export function codexOptions(): AcpClientOptions {
  return {
    provider: 'CODEX',
    workingDir: '/tmp/workspace',
    sessionId: 'test-session-1',
  };
}

export function defaultContext() {
  return { workspaceId: 'w1', workingDir: '/tmp/workspace' };
}

export function defaultConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select' as const,
      category: 'model',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      type: 'select' as const,
      category: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
}

export function subagentBrowseCapabilities(): Record<string, unknown> {
  return {
    loadSession: {},
    _meta: {
      [SUBAGENTS_CAPABILITY_META_KEY]: {
        version: 1,
        list: true,
        read: true,
        notifications: true,
      },
    },
  };
}

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
