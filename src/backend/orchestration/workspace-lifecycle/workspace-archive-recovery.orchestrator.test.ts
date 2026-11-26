import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { JobRunner } from '@/backend/services/job-runner.service';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { ArchiveWorkspaceDependencies } from './workspace-archive.orchestrator';

const resumeStaleArchives = vi.hoisted(() =>
  vi.fn<
    (
      services: unknown,
      options: { limit: number; signal: AbortSignal }
    ) => Promise<{
      archived: string[];
      failed: Array<{ id: string; error: string }>;
      skipped: string[];
    }>
  >()
);
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('./workspace-archive.orchestrator', () => ({ resumeStaleArchives }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => log }));

import {
  ARCHIVE_RECOVERY_BATCH,
  REGISTRATION_REMOVALS_PER_SWEEP,
  REGISTRATION_SWEEP_INTERVAL_MS,
  WorkspaceArchiveRecovery,
} from './workspace-archive-recovery.orchestrator';

const archive = unsafeCoerce<ArchiveWorkspaceDependencies>({});
const empty = () => ({ archived: [], failed: [], skipped: [] });

describe('WorkspaceArchiveRecovery', () => {
  let runner: JobRunner;
  let now: number;
  const removeLeftoverRegistrations = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    runner = new JobRunner();
    now = 0;
    resumeStaleArchives.mockImplementation(async () => empty());
    removeLeftoverRegistrations.mockResolvedValue({ removed: [], failed: [] });
  });

  afterEach(async () => {
    await runner.stopAll();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const create = () =>
    new WorkspaceArchiveRecovery(
      { archive, registrations: { removeLeftoverRegistrations }, now: () => now },
      runner
    );

  it('runs at start, then every interval, resuming a bounded batch', async () => {
    const recovery = create();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(resumeStaleArchives).toHaveBeenCalledExactlyOnceWith(archive, {
      limit: ARCHIVE_RECOVERY_BATCH,
      signal: expect.any(AbortSignal),
    });

    await vi.advanceTimersByTimeAsync(SERVICE_INTERVAL_MS.archiveRecovery);
    expect(resumeStaleArchives).toHaveBeenCalledTimes(2);
    await recovery.stop();
  });

  it('sweeps leftover registrations on the first run and then at most every 30 minutes', async () => {
    const recovery = create();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(removeLeftoverRegistrations).toHaveBeenCalledExactlyOnceWith({
      limit: REGISTRATION_REMOVALS_PER_SWEEP,
      signal: expect.any(AbortSignal),
    });

    now = REGISTRATION_SWEEP_INTERVAL_MS - 1;
    await vi.advanceTimersByTimeAsync(SERVICE_INTERVAL_MS.archiveRecovery);
    expect(resumeStaleArchives).toHaveBeenCalledTimes(2);
    expect(removeLeftoverRegistrations).toHaveBeenCalledTimes(1);

    now = REGISTRATION_SWEEP_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(SERVICE_INTERVAL_MS.archiveRecovery);
    expect(removeLeftoverRegistrations).toHaveBeenCalledTimes(2);
    await recovery.stop();
  });

  it('retries a failed registration sweep on the next run', async () => {
    const recovery = create();
    removeLeftoverRegistrations.mockRejectedValueOnce(new Error('database is locked'));
    await expect(recovery.run(new AbortController().signal)).rejects.toThrow('database is locked');

    await recovery.run(new AbortController().signal);
    expect(removeLeftoverRegistrations).toHaveBeenCalledTimes(2);
    await recovery.run(new AbortController().signal);
    expect(removeLeftoverRegistrations).toHaveBeenCalledTimes(2);
  });

  it('ends a run at the next check when stopped, without sweeping registrations', async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseResume!: () => void;
    resumeStaleArchives.mockImplementationOnce(async (_services, options) => {
      observedSignal = options.signal;
      await new Promise<void>((resolve) => {
        releaseResume = resolve;
      });
      return empty();
    });
    const recovery = create();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);

    const stopped = recovery.stop();
    expect(observedSignal?.aborted).toBe(true);
    releaseResume();
    await stopped;
    expect(removeLeftoverRegistrations).not.toHaveBeenCalled();
  });

  it('logs a summary only when a run did something', async () => {
    const recovery = create();
    await recovery.run(new AbortController().signal);
    resumeStaleArchives.mockResolvedValueOnce({ archived: [], failed: [], skipped: ['ws-owned'] });
    await recovery.run(new AbortController().signal);
    expect(log.info).not.toHaveBeenCalled();

    resumeStaleArchives.mockResolvedValueOnce({
      archived: ['ws-a'],
      failed: [{ id: 'ws-b', error: 'remove failed' }],
      skipped: ['ws-c'],
    });
    removeLeftoverRegistrations.mockResolvedValueOnce({
      removed: [{ projectId: 'p', workspaceId: 'ws-d', path: '/wt/workspace-ws-d' }],
      failed: [],
    });
    now = REGISTRATION_SWEEP_INTERVAL_MS;
    await recovery.run(new AbortController().signal);
    expect(log.info).toHaveBeenCalledExactlyOnceWith('Archive recovery run finished', {
      archived: ['ws-a'],
      failed: [{ id: 'ws-b', error: 'remove failed' }],
      skipped: ['ws-c'],
      registrationsRemoved: [{ projectId: 'p', workspaceId: 'ws-d', path: '/wt/workspace-ws-d' }],
      registrationsFailed: [],
    });
  });
});
