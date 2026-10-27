import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it } from 'vitest';
import type { SessionDeltaEvent } from '@/shared/acp-protocol/protocol';
import { AcpEventTranslator } from '@/shared/acp-protocol/session-update-translator';
import { createAcpConnection } from './acp-connection';
import {
  resolveProviderAcpSpawnCommand,
  terminateCatalogProcess,
  withTimeout,
} from './acp-runtime-spawn';
import { terminateDisposableProcessTree } from './disposable-process-cleanup';

// Explicit opt-in: three small live requests per provider, including native /compact.
// Credentials are reused read-only; sessions and Codex auth copies are disposable.
const describeLive =
  process.env.RUN_REAL_PROVIDER_COMPACTION_TESTS === '1' ? describe : describe.skip;

describeLive('real provider compaction (disposable sessions)', () => {
  it.each(['CLAUDE', 'CODEX'] as const)(
    '%s reports usage, compacts and recalls retained context',
    async (provider) => {
      const root = await mkdtemp(join(tmpdir(), 'ff-real-compaction-'));
      try {
        const cwd = join(root, 'workspace');
        await mkdir(cwd);
        const env = {
          ...process.env,
          BROWSER: 'none',
          ELECTRON_RUN_AS_NODE: '1',
          CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
        };
        if (provider === 'CODEX') {
          const codexHome = join(root, 'codex-home');
          await mkdir(codexHome, { mode: 0o700 });
          await copyFile(
            join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
            join(codexHome, 'auth.json')
          );
          await writeFile(
            join(codexHome, 'config.toml'),
            'sandbox_mode = "read-only"\napproval_policy = "never"\nmodel_reasoning_effort = "low"\n'
          );
          Object.assign(env, {
            CODEX_HOME: codexHome,
            DOTENV_CONFIG_QUIET: 'true',
            DISABLE_MCP_CONFIG_FILTERING: 'true',
          });
        }
        const command = resolveProviderAcpSpawnCommand(provider);
        const child = spawn(command.command, command.args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
        // Consume stderr without printing authentication or provider diagnostic payloads.
        child.stderr.resume();
        const updates: SessionUpdate[] = [];
        const deltas: SessionDeltaEvent[] = [];
        const translator = new AcpEventTranslator({ warn: () => undefined });
        const connection = createAcpConnection(
          {
            sessionUpdate: ({ update, sessionId }) => {
              updates.push(update);
              deltas.push(...translator.translateSessionUpdate(update, sessionId));
              return Promise.resolve();
            },
            requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
          },
          ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
          )
        );
        try {
          await withTimeout({
            promise: connection.initialize({
              protocolVersion: PROTOCOL_VERSION,
              clientCapabilities: { session: { compaction: {} } },
            }),
            timeoutMs: 30_000,
            description: 'live compaction initialize',
          });
          const session = await withTimeout({
            promise: connection.newSession({
              cwd,
              mcpServers: [],
              ...(provider === 'CLAUDE'
                ? {
                    _meta: {
                      claudeCode: {
                        options: {
                          tools: [],
                          settingSources: [],
                          skills: [],
                          persistSession: false,
                          promptSuggestions: false,
                        },
                      },
                    },
                  }
                : {}),
            }),
            timeoutMs: 45_000,
            description: 'live compaction new session',
          });
          const sendText = (text: string) =>
            withTimeout({
              promise: connection.prompt({
                sessionId: session.sessionId,
                prompt: [{ type: 'text', text }],
              }),
              timeoutMs: 180_000,
              description: `${provider} live compaction prompt`,
            });
          const marker = 'FF_COMPACTION_KEEP_ORCHID_714';
          const notes = Array.from(
            { length: 160 },
            (_, index) =>
              `Historical note ${index}: routine status remains green; no pending work; this obsolete status note is disposable and need not be retained.`
          ).join('\n');
          await expect(
            sendText(
              `Remember this exact project marker for later: ${marker}. The marker is the only important fact. Do not use tools or read or modify files. Reply with exactly SEEDED.\n\nDisposable older notes:\n${notes}`
            )
          ).resolves.toMatchObject({ stopReason: 'end_turn' });
          const usageBefore = updates
            .filter((value) => value.sessionUpdate === 'usage_update')
            .at(-1);
          expect(usageBefore).toMatchObject({ used: expect.any(Number), size: expect.any(Number) });
          expect(usageBefore?.used).toBeGreaterThan(0);
          expect(usageBefore?.size).toBeGreaterThan(0);
          const compactStart = updates.length;
          const deltaStart = deltas.length;
          await expect(sendText('/compact')).resolves.toMatchObject({ stopReason: 'end_turn' });
          const compactUpdates = updates
            .slice(compactStart)
            .filter((value) => value.sessionUpdate === 'compaction_update');
          expect(compactUpdates.map((value) => value.status)).toContain('in_progress');
          expect(compactUpdates.map((value) => value.status)).toContain('completed');
          expect(compactUpdates.map((value) => value.status)).not.toContain('failed');
          expect(compactUpdates.map((value) => value.status)).not.toContain('cancelled');
          const compactDeltas = deltas.slice(deltaStart);
          expect(compactDeltas).toContainEqual({ type: 'compacting_start' });
          expect(compactDeltas).toContainEqual({ type: 'compacting_end' });
          expect(compactDeltas.filter((value) => value.type === 'compact_boundary')).toHaveLength(
            1
          );
          const usageAfterCompact = updates
            .slice(compactStart)
            .filter((value) => value.sessionUpdate === 'usage_update')
            .at(-1);
          const recallStart = updates.length;
          await expect(
            sendText(
              'What is the exact project marker I asked you to remember? Reply only with that marker. Do not use tools.'
            )
          ).resolves.toMatchObject({ stopReason: 'end_turn' });
          const recall = updates
            .slice(recallStart)
            .filter((value) => value.sessionUpdate === 'agent_message_chunk')
            .map((value) => (value.content.type === 'text' ? value.content.text : ''))
            .join('');
          expect(recall).toContain(marker);
          const usageAfterRecall = updates
            .slice(recallStart)
            .filter((value) => value.sessionUpdate === 'usage_update')
            .at(-1);
          expect(usageAfterRecall?.used).toBeGreaterThan(0);
          expect(updates.some((value) => value.sessionUpdate === 'tool_call')).toBe(false);
          process.stdout.write(
            `${JSON.stringify({
              provider,
              result: 'compaction verified',
              before: usageBefore,
              afterCompact: usageAfterCompact,
              afterRecall: usageAfterRecall,
              statuses: compactUpdates.map((value) => value.status),
              recall,
              boundaries: compactDeltas.filter((value) => value.type === 'compact_boundary').length,
            })}\n`
          );
        } finally {
          try {
            await connection.close();
          } finally {
            child.stdin.end();
            try {
              await terminateDisposableProcessTree(child);
              await terminateCatalogProcess(child);
            } finally {
              child.stdin.destroy();
              child.stdout.destroy();
              child.stderr.destroy();
            }
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    600_000
  );
});
