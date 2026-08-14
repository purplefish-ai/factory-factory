import { SUBAGENTS_CAPABILITY_META_KEY } from '@/shared/acp-protocol/subagents';
import type { AcpClientOptions } from './types';

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
