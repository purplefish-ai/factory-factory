import { describe, expect, it } from 'vitest';
import { deferred } from '@/test-utils/deferred';
import { AcpRuntimeManager } from './acp-runtime-manager';

const runBothProviders = process.env.RUN_REAL_AGENT_STEERING_TESTS === '1';
const providers = runBothProviders ? (['CODEX', 'CLAUDE'] as const) : (['CODEX'] as const);
const describeLive =
  runBothProviders || process.env.RUN_REAL_CODEX_APP_SERVER_PROMPT_TESTS === '1'
    ? describe
    : describe.skip;

describeLive('Live agent steering', () => {
  it.each(providers)(
    '%s delivers a follow-up before the original prompt finishes',
    async (provider) => {
      const manager = new AcpRuntimeManager();
      const sessionId = `manual-steering-${Date.now()}`;
      const chunks: string[] = [];
      const toolStarted = deferred();
      let settled = false;
      try {
        const handle = await manager.getOrCreateClient(
          sessionId,
          {
            provider,
            workingDir: process.cwd(),
            sessionId,
          },
          {
            onAcpEvent: (_id, event) => {
              if (event.type !== 'acp_session_update') {
                return;
              }
              if (event.update.sessionUpdate === 'tool_call') {
                toolStarted.resolve();
              }
              if (
                event.update.sessionUpdate === 'agent_message_chunk' &&
                event.update.content.type === 'text'
              ) {
                chunks.push(event.update.content.text);
              }
            },
          },
          { workspaceId: 'manual-steering-check', workingDir: process.cwd() }
        );
        expect(handle.supportsSteering).toBe(true);
        await manager.setSessionMode(sessionId, provider === 'CODEX' ? 'read-only' : 'plan');
        const original = manager
          .sendPrompt(
            sessionId,
            [
              {
                type: 'text',
                text: 'Run the shell command sleep 5. Do not inspect or modify any files. After the command, reply exactly ORIGINAL_REPLY.',
              },
            ],
            90_000
          )
          .finally(() => {
            settled = true;
          });
        await Promise.race([
          toolStarted.promise,
          original.then(() => {
            throw new Error('Original prompt finished before the tool started');
          }),
        ]);
        expect(settled).toBe(false);
        await expect(
          manager.steerSession(sessionId, [
            {
              type: 'text',
              text: 'Updated instruction: your final reply must be exactly ACP_STEER_LANDED.',
            },
          ])
        ).resolves.toEqual({ outcome: 'injected' });
        await expect(original).resolves.toEqual({ stopReason: 'end_turn' });
        expect(chunks.join('')).toContain('ACP_STEER_LANDED');
      } finally {
        await manager.stopAllClients();
      }
    },
    120_000
  );
});
