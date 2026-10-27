import { type ChildProcess, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getCurrentProcessEnv } from '@/backend/services/logger.service';
import { terminateCatalogProcess, withTimeout } from './acp-runtime-spawn';
import { normalizeClaudePlanUsage, type PlanUsageReading } from './provider-usage-normalizer';

/** Read the native /usage control API without submitting an inference turn. */
export async function fetchClaudePlanUsage(): Promise<PlanUsageReading> {
  const abortController = new AbortController();
  let finishInput!: () => void;
  const inputFinished = new Promise<void>((resolve) => {
    finishInput = resolve;
  });
  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await inputFinished;
        return { done: true, value: undefined };
      },
    }),
  };
  let child: ChildProcess | undefined;
  const session = query({
    prompt: input,
    options: {
      cwd: tmpdir(),
      abortController,
      persistSession: false,
      settingSources: ['user'],
      tools: [],
      strictMcpConfig: true,
      mcpServers: {},
      env: { ...getCurrentProcessEnv(), ELECTRON_RUN_AS_NODE: '1' },
      spawnClaudeCodeProcess: (options) => {
        const args = options.args.map((argument) =>
          argument.replace(/\.asar([/\\])/g, '.asar.unpacked$1')
        );
        const providerProcess = spawn(
          options.command === 'node' ? process.execPath : options.command,
          args,
          {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );
        child = providerProcess;
        return providerProcess;
      },
    },
  });
  try {
    return await withTimeout({
      timeoutMs: 15_000,
      description: 'Claude plan usage',
      promise: (async () => {
        await session.initializationResult();
        const response = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
          skipBehaviors: true,
        });
        return normalizeClaudePlanUsage(response);
      })(),
    });
  } finally {
    finishInput();
    session.close();
    abortController.abort();
    if (child) {
      await terminateCatalogProcess(child);
    }
  }
}
