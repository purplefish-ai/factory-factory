import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { getCurrentProcessEnv } from '@/backend/services/logger.service';
import { withTimeout } from './acp-runtime-spawn';
import { resolveCodexPlanUsageSpawnCommand } from './codex-plan-usage-spawn';
import { terminateDisposableProcessTree } from './disposable-process-cleanup';
import { normalizeCodexPlanUsage, type PlanUsageReading } from './provider-usage-normalizer';

const responseSchema = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
// Only the auth discriminator is needed. Discard account identity fields immediately.
const accountSchema = z.object({ account: z.object({ type: z.string() }).nullable() });

/** Read plan quota through a disposable native process without starting an inference turn. */
export async function fetchCodexPlanUsage(): Promise<PlanUsageReading> {
  const command = resolveCodexPlanUsageSpawnCommand();
  const child = spawn(command.command, command.args, {
    cwd: tmpdir(),
    detached: process.platform !== 'win32',
    env: {
      ...getCurrentProcessEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      DOTENV_CONFIG_QUIET: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  const processFailed = () => fail(new Error('Codex plan usage process failed'));
  child.on('error', processFailed);
  child.on('exit', () => fail(new Error('Codex plan usage process exited')));
  child.stdin.on('error', processFailed);
  child.stdout.on('error', processFailed);
  child.stderr.on('error', processFailed);
  // Native stderr may contain account details or credentials. Drain it without logging.
  child.stderr.resume();
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = responseSchema.safeParse(value);
    if (!parsed.success) {
      return;
    }
    const request = pending.get(parsed.data.id);
    if (!request) {
      return;
    }
    pending.delete(parsed.data.id);
    if (parsed.data.error) {
      request.reject(new Error('Codex plan usage request failed'));
    } else {
      request.resolve(parsed.data.result);
    }
  });
  const request = (method: string, params?: unknown): Promise<unknown> => {
    if (failure) {
      return Promise.reject(failure);
    }
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  const readUsage = async (): Promise<PlanUsageReading> => {
    await request('initialize', {
      clientInfo: { name: 'factory-factory-plan-usage', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const account = accountSchema.safeParse(await request('account/read', { refreshToken: false }));
    if (!account.success) {
      throw new Error('Codex plan usage account response was invalid');
    }
    if (account.data.account?.type !== 'chatgpt') {
      return { status: 'unavailable', windows: [] };
    }
    const usage = await request('account/rateLimits/read');
    try {
      return normalizeCodexPlanUsage(usage);
    } catch {
      throw new Error('Codex plan usage response was invalid');
    }
  };
  try {
    return await withTimeout({
      promise: readUsage(),
      // Reserve the process terminator's five-second grace period within 15 seconds.
      timeoutMs: 10_000,
      description: 'Codex plan usage',
    });
  } finally {
    fail(new Error('Codex plan usage closed'));
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
