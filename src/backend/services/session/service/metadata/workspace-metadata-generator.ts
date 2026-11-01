import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getOwnedCodexCommand } from '@/backend/lib/owned-codex-command';
import { terminateDisposableProcessTree } from '@/backend/lib/owned-process-cleanup';
import { WORKSPACE_METADATA_INSTRUCTIONS } from '@/backend/prompts/workspace-metadata';
import {
  codexAccountService,
  getMetadataCredentialsStore,
} from '@/backend/services/codex-accounts';
import { configService } from '@/backend/services/config.service';
import { spawnClaudeCodeProcess } from '@/backend/services/session/service/acp/claude-code-process';
import { WorkspaceMetadataResultSchema } from '@/shared/workspace-conversation-summary';

export interface WorkspaceMetadataGenerationInput {
  provider: 'CODEX' | 'CLAUDE';
  codexAccountId?: string | null;
  input: unknown;
}

/** Disposable metadata inference: no working-session mutation, tools, or repository context. */
export async function generateWorkspaceMetadata(
  input: WorkspaceMetadataGenerationInput,
  signal: AbortSignal
) {
  const settings = configService.getWorkspaceMetadataConfig();
  const directory = await mkdtemp(join(tmpdir(), 'ff-workspace-metadata-'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  const timeout = setTimeout(abort, 45_000);
  timeout.unref?.();
  try {
    controller.signal.throwIfAborted();
    const schema = z.toJSONSchema(WorkspaceMetadataResultSchema);
    const prompt = JSON.stringify(input.input);
    if (input.provider === 'CLAUDE') {
      const session = query({
        prompt,
        options: {
          cwd: directory,
          model: settings.claudeModel,
          effort: 'low',
          systemPrompt: WORKSPACE_METADATA_INSTRUCTIONS,
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
      try {
        for await (const message of session) {
          if (message.type === 'result' && message.subtype === 'success') {
            return WorkspaceMetadataResultSchema.parse(message.structured_output);
          }
        }
        throw new Error('Workspace metadata generation did not return structured output');
      } finally {
        session.close();
      }
    }

    const context = await codexAccountService.getRuntimeContext(input.codexAccountId ?? undefined);
    const credentialsStore = await getMetadataCredentialsStore(context, controller.signal);
    const instructions = join(directory, 'instructions.txt');
    const outputSchema = join(directory, 'schema.json');
    const output = join(directory, 'result.json');
    await writeFile(instructions, WORKSPACE_METADATA_INSTRUCTIONS);
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
      settings.codexModel,
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
        child = spawn(command.command, command.args, {
          cwd: directory,
          env: { ...context.env, ELECTRON_RUN_AS_NODE: '1', DOTENV_CONFIG_QUIET: 'true' },
          signal: controller.signal,
          timeout: 45_000,
          stdio: ['pipe', 'ignore', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
        child.once('error', () => reject(new Error('Workspace metadata provider call failed')));
        child.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error('Workspace metadata provider call failed'))
        );
        child.stderr?.resume();
        child.stdin?.on('error', () =>
          reject(new Error('Workspace metadata provider input failed'))
        );
        child.stdin?.end(prompt);
      });
      if ((await stat(output)).size > 16_384) {
        throw new Error('Workspace metadata response exceeded limit');
      }
      const value: unknown = JSON.parse(await readFile(output, 'utf8'));
      return WorkspaceMetadataResultSchema.parse(value);
    } finally {
      if (child) {
        await terminateDisposableProcessTree(child);
      }
    }
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
}
