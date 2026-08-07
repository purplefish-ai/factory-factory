import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { AcpRuntimeEvent } from './acp-runtime-events';
import { AcpRuntimeManager } from './acp-runtime-manager';
import type { AcpClientOptions } from './types';

const RUN_REAL_OPENHANDS_TESTS = process.env.RUN_REAL_OPENHANDS_TESTS === '1';
const RUN_REAL_OPENHANDS_PROMPT_TESTS = process.env.RUN_REAL_OPENHANDS_PROMPT_TESTS === '1';

const describeIfRealOpenHands = RUN_REAL_OPENHANDS_TESTS ? describe : describe.skip;
const promptItIfEnabled = RUN_REAL_OPENHANDS_PROMPT_TESTS ? it : it.skip;

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'openhands-acp-it-'));
}

describeIfRealOpenHands('AcpRuntimeManager (manual real OpenHands)', () => {
  it('spawns `openhands acp`, handshakes, and creates a session', async () => {
    // OpenHands cold start (agent load + first LLM round-trip) can exceed the
    // 30s default; allow up to 90s for initialize + newSession.
    const manager = new AcpRuntimeManager({ acpStartupTimeoutMs: 90_000 });
    const workDir = makeWorkDir();
    const sessionId = `openhands-init-${Date.now()}`;

    const options: AcpClientOptions = {
      provider: 'OPENHANDS',
      workingDir: workDir,
      sessionId,
      // YOLO -> autoApprovePolicy 'all', so no permission bridge is required.
      permissionPreset: 'YOLO',
      mcpServers: [],
    };

    try {
      const handle = await manager.getOrCreateClient(
        sessionId,
        options,
        {
          onSessionId: async () => Promise.resolve(),
          onExit: async () => Promise.resolve(),
          onError: () => undefined,
          onAcpEvent: () => undefined,
        },
        { workspaceId: 'manual-runtime-check', workingDir: workDir }
      );

      expect(handle.provider).toBe('OPENHANDS');
      expect(handle.isRunning()).toBe(true);
      expect(typeof handle.providerSessionId).toBe('string');
      expect(handle.providerSessionId.length).toBeGreaterThan(0);

      // OpenHands is router-backed: the model is fixed via LLM_MODEL/--override-with-envs,
      // so it advertises no model selector. The contract only requires `mode` for OPENHANDS.
      const categories = handle.configOptions.map((option) => option.category);
      expect(categories).toContain('mode');
    } finally {
      await manager.stopAllClients();
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 150_000);

  promptItIfEnabled(
    'runs a prompt turn end-to-end against real OpenHands',
    async () => {
      const manager = new AcpRuntimeManager({ acpStartupTimeoutMs: 90_000 });
      const workDir = makeWorkDir();
      const sessionId = `openhands-prompt-${Date.now()}`;
      const events: AcpRuntimeEvent[] = [];

      const options: AcpClientOptions = {
        provider: 'OPENHANDS',
        workingDir: workDir,
        sessionId,
        permissionPreset: 'YOLO',
        mcpServers: [],
      };

      try {
        await manager.getOrCreateClient(
          sessionId,
          options,
          {
            onSessionId: async () => Promise.resolve(),
            onExit: async () => Promise.resolve(),
            onError: () => undefined,
            onAcpEvent: (_sessionId, event: AcpRuntimeEvent) => {
              events.push(event);
            },
          },
          { workspaceId: 'manual-runtime-check', workingDir: workDir }
        );

        const prompt: ContentBlock[] = [
          { type: 'text', text: 'Reply with exactly one word: pong' },
        ];
        const result = await manager.sendPrompt(sessionId, prompt, 120_000);

        expect(['end_turn', 'cancelled']).toContain(result.stopReason);
        expect(events.length).toBeGreaterThan(0);
      } finally {
        await manager.stopAllClients();
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    200_000
  );
});
