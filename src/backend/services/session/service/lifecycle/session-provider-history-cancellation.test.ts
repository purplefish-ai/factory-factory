import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import * as reader from '@/backend/services/session/service/data/session-history-jsonl-reader';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { createProviderHistoryHydrator } from './session-provider-history-hydrator';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(['CLAUDE', 'CODEX'] as const)(
  'cancels the actual %s loader at the next entry when the hydration identity is replaced',
  async (provider) => {
    const directory = mkdtempSync(join(tmpdir(), 'ff-real-history-cancel-'));
    directories.push(directory);
    const domain = new SessionDomainService();
    const entries = [
      { type: 'session_meta', payload: { id: 'old', cwd: '/work' } },
      {
        type: 'response_item',
        payload: { type: 'reasoning', turn_id: 'turn', ignored: 'x'.repeat(1_100_000) },
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: 'event_msg',
        payload: { type: 'user_message', message: `prompt ${index}` },
      })),
    ];
    const sessionsDir = join(directory, 'sessions');
    const dateDirectory = join(sessionsDir, '2026', '11', '02');
    mkdirSync(dateDirectory, { recursive: true });
    const filePath = join(dateDirectory, 'rollout-old.jsonl');
    writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n'));
    const original = reader.readNonEmptyJsonlLines;
    let delivered = 0;
    vi.spyOn(reader, 'readNonEmptyJsonlLines').mockImplementation(async (input) => {
      // Exercise each real loader and its forwarded identity callback against the
      // same large file, without touching native provider directories.
      await original({
        ...input,
        filePath,
        onLine: (entry, lineNumber) => {
          delivered++;
          if (delivered === 1) {
            domain.resetProviderHistory('session', 'replacement');
          }
          return input.onLine(entry, lineNumber);
        },
      });
    });
    if (provider === 'CLAUDE') {
      // Resolve a native Claude path through its own loader, using the explicit
      // working-directory fixture and a temporary config root.
      vi.spyOn(configService, 'getClaudeConfigDir').mockReturnValue(directory);
      const project = join(directory, 'projects', '-work');
      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(project, 'old.jsonl'),
        entries.map((entry) => JSON.stringify(entry)).join('\n')
      );
    }
    await createProviderHistoryHydrator(domain)('session', {
      provider,
      providerSessionId: 'old',
      providerMetadata: {},
      workspace: { worktreePath: '/work' },
      codexAccountContext: { accountId: 'fixture', homeDir: directory, sessionsDir, env: {} },
    });
    expect(delivered).toBe(1);
    expect(domain.getTranscriptSnapshot('session')).toEqual([]);
    expect(domain.acceptProviderHistoryIdentity('session', 'replacement')).toBe(true);
    expect(domain.canAttemptHistoryHydration('session')).toBe(true);
  }
);
