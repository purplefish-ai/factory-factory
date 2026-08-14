import { SUBAGENTS_CAPABILITY_META_KEY } from '@/shared/acp-protocol/subagents';

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
