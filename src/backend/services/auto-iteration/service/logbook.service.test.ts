import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogbookService } from './logbook.service';

describe('LogbookService', () => {
  let service: LogbookService;
  let worktreePath: string;

  beforeEach(async () => {
    service = new LogbookService();
    worktreePath = await mkdtemp(join(tmpdir(), 'ff-logbook-'));
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it('returns null when the logbook does not exist', async () => {
    await expect(service.read(worktreePath)).resolves.toBeNull();
  });

  it('writes and reads a validated logbook', async () => {
    await service.initialize(
      worktreePath,
      'ws-1',
      {
        testCommand: 'pnpm test',
        targetDescription: 'Improve coverage',
        maxIterations: 5,
        testTimeoutSeconds: 120,
        sessionRecycleInterval: 3,
      },
      'baseline output',
      '10 tests passing'
    );

    await service.appendEntry(worktreePath, {
      iteration: 1,
      startedAt: '2026-05-17T12:01:00.000Z',
      completedAt: '2026-05-17T12:02:00.000Z',
      status: 'accepted',
      changeDescription: 'Added coverage',
      commitSha: 'abc123',
      commitReverted: false,
      metricBefore: '10 tests passing',
      metricAfter: '12 tests passing',
      testOutput: 'ok',
      metricImproved: true,
      crashError: null,
      fixAttempts: 0,
      critiqueNotes: 'Looks good',
      critiqueApproved: true,
    });

    const logbook = await service.read(worktreePath);

    expect(logbook?.workspaceId).toBe('ws-1');
    expect(logbook?.iterations).toHaveLength(1);
  });

  it('rejects malformed logbook JSON structures', async () => {
    const logbookDir = join(worktreePath, '.factory-factory');
    await mkdir(logbookDir, { recursive: true });
    await writeFile(
      join(logbookDir, 'auto-iteration-logbook.json'),
      JSON.stringify({ workspaceId: 'ws-1', iterations: [] }),
      'utf-8'
    );

    await expect(service.read(worktreePath)).rejects.toThrow();
  });

  it('does not overwrite an existing strategy file', async () => {
    const strategyDir = join(worktreePath, '.factory-factory');
    const strategyPath = join(strategyDir, 'auto-iteration-strategy.md');
    await mkdir(strategyDir, { recursive: true });
    await writeFile(strategyPath, 'custom strategy', 'utf-8');

    await service.writeStrategyFile(worktreePath, 'default strategy');

    await expect(readFile(strategyPath, 'utf-8')).resolves.toBe('custom strategy');
  });
});
