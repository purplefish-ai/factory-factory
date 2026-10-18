import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { getCurrentProcessEnv } from '@/backend/services/logger.service';
import { resolveProviderAcpSpawnCommand, withTimeout } from './acp-runtime-spawn';

const modelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  defaultReasoningEffort: z.string().nullable().default(null),
  supportedReasoningEfforts: z
    .array(
      z.object({
        reasoningEffort: z.string(),
        description: z.string().optional(),
      })
    )
    .default([]),
  inputModalities: z.array(z.string()).default([]),
  isDefault: z.boolean().default(false),
});
const pageSchema = z.object({ data: z.array(modelSchema), nextCursor: z.string().nullish() });
const responseSchema = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
export type CodexModelCatalogEntry = z.infer<typeof modelSchema>;

/** Lightweight discovery only: the upstream adapter owns sessions and harness RPCs. */
export async function fetchCodexModelCatalogFromAppServer(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexModelCatalogEntry[]> {
  const command = resolveProviderAcpSpawnCommand('CODEX');
  const child = spawn(command.command, [...command.args, 'cli', 'app-server'], {
    cwd: options?.cwd ?? tmpdir(),
    env: { ...(options?.env ?? getCurrentProcessEnv()), ELECTRON_RUN_AS_NODE: '1' },
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
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Codex model discovery process exited')));
  child.stdin.on('error', fail);
  child.stderr.resume();
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail(new Error('Invalid Codex discovery response'));
      return;
    }
    const parsed = responseSchema.safeParse(value);
    if (!parsed.success) {
      return;
    } // Notifications are not model discovery results.
    const request = pending.get(parsed.data.id);
    if (!request) {
      return;
    }
    pending.delete(parsed.data.id);
    if (parsed.data.error) {
      request.reject(new Error(parsed.data.error.message));
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
  const discover = async () => {
    await request('initialize', {
      clientInfo: { name: 'factory-factory-model-catalog', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const models: CodexModelCatalogEntry[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = pageSchema.parse(await request('model/list', cursor ? { cursor } : {}));
      models.push(...page.data);
      cursor = page.nextCursor ?? null;
      if (cursor && cursors.has(cursor)) {
        throw new Error('Repeated Codex model catalog cursor');
      }
      if (cursor) {
        cursors.add(cursor);
      }
    } while (cursor);
    return models;
  };
  try {
    return await withTimeout({
      promise: discover(),
      timeoutMs: 30_000,
      description: 'Codex model discovery',
    });
  } finally {
    fail(new Error('Codex model discovery closed'));
    reader.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2000);
        timer.unref?.();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  }
}
