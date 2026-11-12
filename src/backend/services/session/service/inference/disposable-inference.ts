import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getOwnedCodexCommand } from '@/backend/lib/owned-codex-command';
import { terminateDisposableProcessTree } from '@/backend/lib/owned-process-cleanup';
import {
  codexAccountService,
  getMetadataCredentialsStore,
} from '@/backend/services/codex-accounts';
import { configService } from '@/backend/services/config.service';
import { spawnClaudeCodeProcess } from '@/backend/services/session/service/acp/claude-code-process';

export interface DisposableInferenceRequest<T> {
  /** Names the call in error messages and its temporary directory. */
  label: string;
  provider: 'CODEX' | 'CLAUDE';
  codexAccountId?: string | null;
  model: string;
  instructions: string;
  prompt: string;
  schema: z.ZodType<T>;
  timeoutMs: number;
}

export type DisposableInferenceFailure = 'TIMEOUT' | 'RATE_LIMITED' | 'FAILED';

/** Typed provider failure; never carries provider output or credentials. */
export class DisposableInferenceError extends Error {
  constructor(
    readonly kind: DisposableInferenceFailure,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'DisposableInferenceError';
  }
}

const RATE_LIMIT_TEXT = /rate.?limit|too many requests|\b429\b|usage limit/i;
const STDERR_TAIL_BYTES = 4096;

/**
 * Disposable structured inference: a fresh temporary directory, no tools, MCP
 * servers, hooks, settings, repository instructions or saved session. Malformed
 * output fails schema parsing; the provider process tree is always cleaned up.
 */
export async function runDisposableInference<T>(
  request: DisposableInferenceRequest<T>,
  signal: AbortSignal
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ff-disposable-inference-'));
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, request.timeoutMs);
  timeout.unref?.();
  try {
    controller.signal.throwIfAborted();
    // Claude's structured-output validator does not support Draft 2020-12.
    const schema = z.toJSONSchema(request.schema, {
      target: request.provider === 'CLAUDE' ? 'draft-7' : 'draft-2020-12',
    });
    return request.provider === 'CLAUDE'
      ? await runClaude(request, schema, directory, controller)
      : await runCodex(request, schema, directory, controller);
  } catch (error) {
    if (timedOut && !signal.aborted) {
      throw new DisposableInferenceError('TIMEOUT', `${request.label} provider call timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
}

type RateLimitObservation = { limited: boolean; retryAfterMs?: number };

function observeClaudeRateLimit(message: SDKMessage, observed: RateLimitObservation) {
  if (
    message.type === 'assistant' &&
    (message.error === 'rate_limit' || message.error === 'overloaded')
  ) {
    observed.limited = true;
  }
  if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') {
    observed.limited = true;
    const resetsAt = message.rate_limit_info.resetsAt;
    if (resetsAt !== undefined) {
      observed.retryAfterMs = Math.max(0, resetsAt * 1000 - Date.now());
    }
  }
}

async function runClaude<T>(
  request: DisposableInferenceRequest<T>,
  schema: Record<string, unknown>,
  directory: string,
  controller: AbortController
) {
  const session = query({
    prompt: request.prompt,
    options: {
      cwd: directory,
      model: request.model,
      effort: 'low',
      systemPrompt: request.instructions,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      settings: { disableAllHooks: true },
      persistSession: false,
      maxTurns: 2,
      abortController: controller,
      outputFormat: { type: 'json_schema', schema },
      env: {
        ...configService.getChildProcessEnv(),
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDE_CODE_SAFE_MODE: '1',
      },
      spawnClaudeCodeProcess,
    },
  });
  const rateLimit: RateLimitObservation = { limited: false };
  try {
    for await (const message of session) {
      observeClaudeRateLimit(message, rateLimit);
      if (message.type === 'result' && message.subtype === 'success') {
        return request.schema.parse(message.structured_output);
      }
    }
  } catch (error) {
    if (!rateLimit.limited) {
      throw error;
    }
  } finally {
    session.close();
  }
  if (rateLimit.limited) {
    throw new DisposableInferenceError(
      'RATE_LIMITED',
      `${request.label} provider is rate limited`,
      rateLimit.retryAfterMs
    );
  }
  throw new DisposableInferenceError(
    'FAILED',
    `${request.label} generation did not return structured output`
  );
}

async function runCodex<T>(
  request: DisposableInferenceRequest<T>,
  schema: Record<string, unknown>,
  directory: string,
  controller: AbortController
) {
  const context = await codexAccountService.getRuntimeContext(request.codexAccountId ?? undefined);
  const credentialsStore = await getMetadataCredentialsStore(context, controller.signal);
  const instructions = join(directory, 'instructions.txt');
  const outputSchema = join(directory, 'schema.json');
  const output = join(directory, 'result.json');
  await writeFile(instructions, request.instructions);
  await writeFile(outputSchema, JSON.stringify(schema));
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-m',
    request.model,
    '-c',
    'model_reasoning_effort="low"',
    '-c',
    `cli_auth_credentials_store=${JSON.stringify(credentialsStore)}`,
    '-c',
    `model_instructions_file=${JSON.stringify(instructions)}`,
    '-c',
    'developer_instructions=""',
    '-c',
    'features.shell_tool=false',
    '-c',
    'features.apply_patch_freeform=false',
    '-c',
    'features.apps=false',
    '-c',
    'skills.include_instructions=false',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'web_search="disabled"',
    '--output-schema',
    outputSchema,
    '--output-last-message',
    output,
    '-',
  ];
  const command = getOwnedCodexCommand(args, context.env);
  let child: ChildProcess | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let stderrTail = '';
      const failed = () =>
        RATE_LIMIT_TEXT.test(stderrTail)
          ? new DisposableInferenceError(
              'RATE_LIMITED',
              `${request.label} provider is rate limited`
            )
          : new Error(`${request.label} provider call failed`);
      child = spawn(command.command, command.args, {
        cwd: directory,
        env: { ...context.env, ELECTRON_RUN_AS_NODE: '1', DOTENV_CONFIG_QUIET: 'true' },
        signal: controller.signal,
        timeout: request.timeoutMs,
        stdio: ['pipe', 'ignore', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      child.once('error', () => reject(new Error(`${request.label} provider call failed`)));
      child.once('close', (code) => (code === 0 ? resolve() : reject(failed())));
      // Keep only a bounded tail to recognize rate limits; it is never logged or stored.
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_BYTES);
      });
      child.stdin?.on('error', () => reject(new Error(`${request.label} provider input failed`)));
      child.stdin?.end(request.prompt);
    });
    if ((await stat(output)).size > 16_384) {
      throw new Error(`${request.label} response exceeded limit`);
    }
    const value: unknown = JSON.parse(await readFile(output, 'utf8'));
    return request.schema.parse(value);
  } finally {
    if (child) {
      await terminateDisposableProcessTree(child);
    }
  }
}
