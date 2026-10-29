import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { getOwnedCodexCommand } from '@/backend/lib/owned-codex-command';
import { terminateDisposableProcessTree } from '@/backend/lib/owned-process-cleanup';
import { acquireNativeSlot } from './native-slots';
import type { CodexRuntimeContext } from './types';
const responseSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type NativeRpc = {
  request(method: string, params?: unknown): Promise<unknown>;
  notification(method: string, listener: (params: unknown) => void): void;
};
export async function withNativeRpc<T>(
  context: CodexRuntimeContext,
  operation: (rpc: NativeRpc) => Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const release = await acquireNativeSlot(timeoutMs, options.signal);
  try {
    return await runNativeRpc(context, operation, {
      ...options,
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
    });
  } finally {
    release();
  }
}
async function runNativeRpc<T>(
  context: CodexRuntimeContext,
  operation: (rpc: NativeRpc) => Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<T> {
  const command = getOwnedCodexCommand(['app-server']);
  const child = spawn(command.command, command.args, {
    cwd: tmpdir(),
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: { ...context.env, ELECTRON_RUN_AS_NODE: '1', DOTENV_CONFIG_QUIET: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const notifications = new Map<string, (value: unknown) => void>();
  let failure: Error | undefined;
  let nextId = 0;
  let buffered = '';
  let rejectOperation!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectOperation = reject;
  });
  const fail = () => {
    failure = new Error('Codex native account operation failed');
    for (const request of pending.values()) {
      request.reject(failure);
    }
    pending.clear();
    rejectOperation(failure);
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('error', fail);
  // Drain private diagnostics. Never expose native stderr or its error strings.
  child.stderr.resume();
  // Bound a malformed native stream before readline can retain an unlimited line.
  child.stdout.on('data', (chunk) => {
    buffered += String(chunk);
    if (buffered.length > 1024 * 1024) {
      fail();
    }
    const newline = buffered.lastIndexOf('\n');
    if (newline >= 0) {
      buffered = buffered.slice(newline + 1);
    }
  });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const response = responseSchema.safeParse(value);
    if (!response.success) {
      return;
    }
    const message = response.data;
    if (message.method) {
      notifications.get(message.method)?.(message.params);
    }
    if (message.id === undefined) {
      return;
    }
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error('Codex native account request failed'));
    } else {
      request.resolve(message.result);
    }
  });
  const rpc: NativeRpc = {
    request(method, params) {
      if (failure) {
        return Promise.reject(failure);
      }
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    notification(method, listener) {
      notifications.set(method, listener);
    },
  };
  const timer = setTimeout(fail, options.timeoutMs ?? 10_000);
  timer.unref?.();
  options.signal?.addEventListener('abort', fail, { once: true });
  try {
    if (options.signal?.aborted) {
      fail();
    }
    return await Promise.race([
      failed,
      (async () => {
        await rpc.request('initialize', {
          clientInfo: { name: 'factory-factory-accounts', version: '1.0.0' },
          capabilities: { experimentalApi: true },
        });
        child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
        return operation(rpc);
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', fail);
    reader.close();
    child.stdin.end();
    try {
      await terminateDisposableProcessTree(child);
    } finally {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}
