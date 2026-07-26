import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindUnique = vi.fn();
const mockFindUniqueOrThrow = vi.fn();
const mockFindMany = vi.fn();
const mockUpdateMany = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspaceRunScript: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findUniqueOrThrow: (...args: unknown[]) => mockFindUniqueOrThrow(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
  },
}));

import {
  flattenWorkspaceRunScript,
  WORKSPACE_RUN_SCRIPT_DEFAULTS,
  workspaceRunScriptAccessor,
} from './workspace-run-script.accessor';

const EXECUTION_SELECT = { status: true, pid: true, port: true, startedAt: true };

describe('workspaceRunScriptAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockReset();
  });

  describe('flattenWorkspaceRunScript', () => {
    it('maps every column back to the flat name callers consume', () => {
      const startedAt = new Date('2026-01-01T00:00:00.000Z');

      expect(
        flattenWorkspaceRunScript({
          workspaceId: 'ws-1',
          command: 'npm run dev',
          postRunCommand: 'npm run smoke',
          cleanupCommand: 'npm run cleanup',
          pid: 123,
          port: 3000,
          startedAt,
          status: 'RUNNING',
        })
      ).toEqual({
        runScriptCommand: 'npm run dev',
        runScriptPostRunCommand: 'npm run smoke',
        runScriptCleanupCommand: 'npm run cleanup',
        runScriptPid: 123,
        runScriptPort: 3000,
        runScriptStartedAt: startedAt,
        runScriptStatus: 'RUNNING',
      });
    });

    it('substitutes the column defaults when no row was joined', () => {
      // A row exists for every workspace, so this covers data that arrived by
      // another route rather than an expected state — but the answer has to match
      // what the pre-split Workspace columns gave a fresh row.
      expect(flattenWorkspaceRunScript(null)).toEqual(WORKSPACE_RUN_SCRIPT_DEFAULTS);
      expect(flattenWorkspaceRunScript(undefined)).toEqual(WORKSPACE_RUN_SCRIPT_DEFAULTS);
      expect(WORKSPACE_RUN_SCRIPT_DEFAULTS.runScriptStatus).toBe('IDLE');
    });

    it('returns a fresh object each time, so a caller cannot mutate the defaults', () => {
      const first = flattenWorkspaceRunScript(null);
      first.runScriptStatus = 'RUNNING';

      expect(flattenWorkspaceRunScript(null).runScriptStatus).toBe('IDLE');
    });
  });

  describe('findExecutionState', () => {
    it('selects only the four process columns and flattens them', async () => {
      const startedAt = new Date('2026-01-01T00:00:00.000Z');
      mockFindUnique.mockResolvedValue({ status: 'RUNNING', pid: 123, port: 3000, startedAt });

      await expect(workspaceRunScriptAccessor.findExecutionState('ws-1')).resolves.toEqual({
        runScriptStatus: 'RUNNING',
        runScriptPid: 123,
        runScriptPort: 3000,
        runScriptStartedAt: startedAt,
      });
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        select: EXECUTION_SELECT,
      });
    });

    it('returns null for a workspace with no row', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(workspaceRunScriptAccessor.findExecutionState('missing')).resolves.toBeNull();
    });
  });

  describe('findExecutionStateOrThrow', () => {
    it('uses findUniqueOrThrow, so a missing row surfaces as an error', async () => {
      mockFindUniqueOrThrow.mockResolvedValue({
        status: 'STOPPING',
        pid: 9,
        port: null,
        startedAt: null,
      });

      await expect(
        workspaceRunScriptAccessor.findExecutionStateOrThrow('ws-1')
      ).resolves.toMatchObject({ runScriptStatus: 'STOPPING', runScriptPid: 9 });
      expect(mockFindUniqueOrThrow).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        select: EXECUTION_SELECT,
      });
    });
  });

  describe('writeCommands', () => {
    it('translates the three command names to columns', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceRunScriptAccessor.writeCommands('ws-1', {
        runScriptCommand: 'npm run dev',
        runScriptPostRunCommand: null,
        runScriptCleanupCommand: 'npm run cleanup',
      });

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        data: { command: 'npm run dev', postRunCommand: null, cleanupCommand: 'npm run cleanup' },
      });
    });

    it('throws when no row matched, so a discarded write is not reported as success', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceRunScriptAccessor.writeCommands('gone', {
          runScriptCommand: null,
          runScriptPostRunCommand: null,
          runScriptCleanupCommand: null,
        })
      ).rejects.toThrow('WorkspaceRunScript row not found for workspace: gone');
    });

    it('writes through the caller transaction when one is supplied', async () => {
      const transactionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const transaction = { workspaceRunScript: { updateMany: transactionUpdateMany } };

      await workspaceRunScriptAccessor.writeCommands(
        'ws-1',
        {
          runScriptCommand: 'npm start',
          runScriptPostRunCommand: null,
          runScriptCleanupCommand: null,
        },
        transaction as never
      );

      expect(transactionUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('casExecutionUpdate', () => {
    it('guards on the status the caller decided from', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceRunScriptAccessor.casExecutionUpdate('ws-1', 'STARTING', {
        runScriptStatus: 'RUNNING',
        runScriptPid: 123,
      });

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', status: 'STARTING' },
        data: { status: 'RUNNING', pid: 123 },
      });
    });

    it('omits absent fields, so a partial transition stays partial', async () => {
      // STOPPING keeps the pid and port it inherited: the process is still there
      // to be killed. Forwarding `undefined` as a value would clear them.
      mockUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceRunScriptAccessor.casExecutionUpdate('ws-1', 'RUNNING', {
        runScriptStatus: 'STOPPING',
        runScriptPid: undefined,
        runScriptPort: undefined,
        runScriptStartedAt: undefined,
      });

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', status: 'RUNNING' },
        data: { status: 'STOPPING' },
      });
    });

    it('reports a lost race as a zero count rather than throwing', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceRunScriptAccessor.casExecutionUpdate('ws-1', 'IDLE', {
          runScriptStatus: 'STARTING',
        })
      ).resolves.toEqual({ count: 0 });
    });
  });

  describe('resetStaleTransientStatuses', () => {
    it('returns an empty array and skips the update when nothing is stale', async () => {
      mockFindMany.mockResolvedValue([]);

      await expect(workspaceRunScriptAccessor.resetStaleTransientStatuses()).resolves.toEqual([]);
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('resets STARTING and STOPPING rows and reports their prior status', async () => {
      mockFindMany.mockResolvedValue([
        { workspaceId: 'ws-1', status: 'STARTING' },
        { workspaceId: 'ws-2', status: 'STOPPING' },
      ]);
      mockUpdateMany.mockResolvedValue({ count: 2 });

      // The caller emits one status-changed event per entry, so it needs the
      // workspace id under `id` — the shape the pre-split read returned.
      await expect(workspaceRunScriptAccessor.resetStaleTransientStatuses()).resolves.toEqual([
        { id: 'ws-1', runScriptStatus: 'STARTING' },
        { id: 'ws-2', runScriptStatus: 'STOPPING' },
      ]);

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { status: { in: ['STARTING', 'STOPPING'] } },
        select: { workspaceId: true, status: true },
      });
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          workspaceId: { in: ['ws-1', 'ws-2'] },
          status: { in: ['STARTING', 'STOPPING'] },
        },
        data: { status: 'IDLE', pid: null, port: null, startedAt: null },
      });
    });

    it('leaves RUNNING, COMPLETED and FAILED alone', async () => {
      // Only the two transient statuses describe a transition a restart broke.
      // RUNNING is what `verifyRunning` re-checks against the persisted pid, and
      // COMPLETED/FAILED are results the user has not acknowledged yet.
      mockFindMany.mockResolvedValue([]);

      await workspaceRunScriptAccessor.resetStaleTransientStatuses();

      const [call] = mockFindMany.mock.calls as [[{ where: { status: { in: string[] } } }]];
      expect(call[0].where.status.in).toEqual(['STARTING', 'STOPPING']);
    });
  });
});
