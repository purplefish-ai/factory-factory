import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { stopOwnedProcessGroup } from '@/backend/lib/owned-process-group';
import { configService } from '@/backend/services/config.service';
import { SERVICE_LIMITS, SERVICE_TIMEOUT_MS } from '@/backend/services/constants';

export class EventSetupError extends Error {
  constructor(
    readonly kind: 'FAILED' | 'ABORTED' | 'TIMED_OUT',
    readonly cleanup: 'CONFIRMED' | 'UNKNOWN',
    message: string
  ) {
    super(message);
  }
}
export type EventStartupScriptOptions = {
  signal: AbortSignal;
  assertCurrent(): Promise<unknown>;
  appendOutput(text: string): Promise<void>;
  setPid(pid: number): Promise<void>;
  clearPid(pid: number): Promise<void>;
  retainPid?(pid: number): Promise<void>;
  physicalStage?(active: boolean): void;
};
/** Event-only execution: foreground work is joined; cancellation requires owned-group proof. */
export async function executeEventStartupScript(
  input: EventStartupScriptOptions & { cwd: string; args: string[]; timeoutMs: number }
) {
  input.signal.throwIfAborted();
  await input.assertCurrent();
  input.signal.throwIfAborted();
  const child = spawn('bash', input.args, {
    cwd: input.cwd,
    env: { ...configService.getChildProcessEnv(), WORKSPACE_PATH: input.cwd },
    detached: process.platform !== 'win32',
  });
  input.physicalStage?.(true);
  const group = { child, ownedProcessGroup: process.platform !== 'win32' ? child.pid : undefined };
  let writes = Promise.resolve();
  let outputError: unknown;
  let stderr = '';
  let settled = false;
  let finishing = false;
  let stopping: Promise<'CONFIRMED' | 'UNKNOWN'> | undefined;
  let failure: EventSetupError['kind'] | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let drainTimeout: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (value: { success: boolean; errorMessage?: string }) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<{ success: boolean; errorMessage?: string }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const queueWrite = (operation: () => Promise<void>) => {
    writes = writes.then(operation).catch((error: unknown) => {
      outputError ??= error;
      stop('FAILED');
    });
  };
  const clearPid = async () => {
    if (child.pid === undefined) {
      return;
    }
    try {
      await input.clearPid(child.pid);
    } catch (cause) {
      outputError ??= cause;
      stop('FAILED');
    }
  };
  const finish = async (code: number | null, error?: Error) => {
    if (finishing) {
      return;
    }
    finishing = true;
    clearTimeout(drainTimeout);
    if (stopping === undefined) {
      input.physicalStage?.(false);
    }
    await writes;
    await clearPid();
    if (input.signal.aborted) {
      abort();
    }
    const cleanup = stopping !== undefined ? await stopping : 'CONFIRMED';
    await retainUncertainPid(cleanup, child.pid, input);
    settled = true;
    clearTimeout(timeout);
    input.signal.removeEventListener('abort', abort);
    if (failure || error || outputError) {
      reject(
        new EventSetupError(failure ?? 'FAILED', cleanup, error?.message ?? failureMessage(failure))
      );
    } else {
      resolve(scriptResult(code, stderr));
    }
  };
  function stop(kind: EventSetupError['kind']) {
    if (settled || stopping !== undefined) {
      return;
    }
    failure = kind;
    input.physicalStage?.(true);
    stopping = Promise.resolve().then(async () => {
      const proof = await stopOwnedProcessGroup(group);
      if (proof === 'UNKNOWN') {
        // Best effort direct cleanup is not promoted into group proof (including Windows).
        try {
          child.kill('SIGKILL');
        } catch {
          /* Retain UNKNOWN. */
        }
      }
      return proof === 'LOCAL_RUNTIME_GROUP_STOPPED'
        ? ('CONFIRMED' as const)
        : ('UNKNOWN' as const);
    });
    void stopping.then(() => {
      input.physicalStage?.(false);
      return finish(null);
    });
  }
  const abort = () =>
    stop(
      input.signal.reason instanceof Error && input.signal.reason.name === 'TimeoutError'
        ? 'TIMED_OUT'
        : 'ABORTED'
    );
  const output = (data: Buffer, stream: Readable, errorOutput: boolean) => {
    if (finishing || stopping !== undefined) {
      return;
    }
    const text = data.toString().slice(-SERVICE_LIMITS.startupScriptOutputTailBytes);
    if (errorOutput) {
      stderr = `${stderr}${text}`.slice(-SERVICE_LIMITS.startupScriptOutputTailBytes);
    }
    // Apply backpressure so noisy scripts cannot queue unbounded database writes.
    stream.pause();
    queueWrite(async () => {
      try {
        await input.assertCurrent();
        await input.appendOutput(text);
      } finally {
        stream.resume();
      }
    });
  };
  child.stdout.on('data', (data: Buffer) => output(data, child.stdout, false));
  child.stderr.on('data', (data: Buffer) => output(data, child.stderr, true));
  child.once('error', (error) => {
    void finish(null, error);
  });
  child.once('close', (code, signal) => {
    if (signal) {
      stop('FAILED');
    }
    if (stopping === undefined) {
      void finish(code);
    }
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      stop('FAILED');
    }
    // Successful setup may intentionally leave dev servers holding pipes; do not kill them.
    if (stopping === undefined) {
      drainTimeout = setTimeout(() => {
        void finish(code);
      }, SERVICE_TIMEOUT_MS.startupScriptOutputDrain);
    }
  });
  const pid = child.pid;
  if (pid !== undefined) {
    queueWrite(() => input.setPid(pid));
  }
  input.signal.addEventListener('abort', abort, { once: true });
  timeout = setTimeout(() => stop('TIMED_OUT'), input.timeoutMs);
  if (input.signal.aborted) {
    abort();
  }
  return result;
}

function scriptResult(code: number | null, stderr: string) {
  return {
    success: code === 0,
    ...(code !== 0 ? { errorMessage: stderr || 'Script failed with non-zero exit code' } : {}),
  };
}

function failureMessage(kind: EventSetupError['kind'] | undefined) {
  if (kind === 'TIMED_OUT') {
    return 'Event setup script timed out';
  }
  if (kind === 'ABORTED') {
    return 'Event setup script aborted';
  }
  return 'Event setup script failed';
}

async function retainUncertainPid(
  cleanup: 'CONFIRMED' | 'UNKNOWN',
  pid: number | undefined,
  input: EventStartupScriptOptions
) {
  if (cleanup === 'UNKNOWN' && pid !== undefined) {
    // A cleared foreground PID is not proof its owned descendants stopped.
    await input.retainPid?.(pid).catch(() => undefined);
  }
}
