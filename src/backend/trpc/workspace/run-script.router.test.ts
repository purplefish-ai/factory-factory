import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindByIdWithProject = vi.hoisted(() => vi.fn());
const mockSetRunScriptCommands = vi.hoisted(() => vi.fn());

vi.mock('@/backend/domains/workspace', () => ({
  workspaceDataService: {
    findByIdWithProject: (...args: unknown[]) => mockFindByIdWithProject(...args),
    setRunScriptCommands: (...args: unknown[]) => mockSetRunScriptCommands(...args),
  },
}));

import { workspaceRunScriptRouter } from './run-script.trpc';

function createCaller(runScriptService?: {
  startRunScript?: (workspaceId: string) => Promise<{
    success: boolean;
    error?: string;
    port?: number;
    pid?: number;
    proxyUrl?: string | null;
  }>;
  stopRunScript?: (workspaceId: string) => Promise<{ success: boolean; error?: string }>;
  getRunScriptStatus?: (workspaceId: string) => Promise<unknown>;
}) {
  return workspaceRunScriptRouter.createCaller({
    appContext: {
      services: {
        runScriptService: {
          startRunScript: runScriptService?.startRunScript ?? (async () => ({ success: true })),
          stopRunScript: runScriptService?.stopRunScript ?? (async () => ({ success: true })),
          getRunScriptStatus:
            runScriptService?.getRunScriptStatus ??
            (async () => ({ status: 'IDLE', workspaceId: 'default' })),
        },
      },
    },
  } as never);
}

describe('workspaceRunScriptRouter', () => {
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceDir = mkdtempSync(join(tmpdir(), 'ff-ws-'));
    repoDir = mkdtempSync(join(tmpdir(), 'ff-repo-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('creates factory config and mirrors it into project repo', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'w1',
      worktreePath: workspaceDir,
      project: { repoPath: repoDir },
    });

    const caller = createCaller();
    await expect(
      caller.createFactoryConfig({
        workspaceId: 'w1',
        config: {
          scripts: {
            run: 'pnpm dev',
            cleanup: 'pkill node',
          },
        },
      })
    ).resolves.toEqual({ success: true });

    const workspaceConfig = readFileSync(join(workspaceDir, 'factory-factory.json'), 'utf8');
    const repoConfig = readFileSync(join(repoDir, 'factory-factory.json'), 'utf8');
    expect(workspaceConfig).toContain('pnpm dev');
    expect(repoConfig).toContain('pnpm dev');
    expect(mockSetRunScriptCommands).toHaveBeenCalledWith('w1', 'pnpm dev', 'pkill node');
  });

  it('validates workspace preconditions for config creation', async () => {
    const caller = createCaller();

    mockFindByIdWithProject.mockResolvedValue(null);
    await expect(
      caller.createFactoryConfig({ workspaceId: 'missing', config: { scripts: {} } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    mockFindByIdWithProject.mockResolvedValue({ id: 'w1', worktreePath: null, project: null });
    await expect(
      caller.createFactoryConfig({ workspaceId: 'w1', config: { scripts: {} } })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('delegates start/stop/status to runScriptService', async () => {
    const startRunScript = vi.fn(async () => ({
      success: true,
      port: 3000,
      pid: 12_345,
      proxyUrl: 'https://proxy.example',
    }));
    const stopRunScript = vi.fn(async () => ({ success: true }));
    const getRunScriptStatus = vi.fn(async () => ({ status: 'RUNNING' }));

    const caller = createCaller({ startRunScript, stopRunScript, getRunScriptStatus });

    await expect(caller.startRunScript({ workspaceId: 'w1' })).resolves.toEqual({
      success: true,
      port: 3000,
      pid: 12_345,
      proxyUrl: 'https://proxy.example',
    });
    await expect(caller.stopRunScript({ workspaceId: 'w1' })).resolves.toEqual({ success: true });
    await expect(caller.getRunScriptStatus({ workspaceId: 'w1' })).resolves.toEqual({
      status: 'RUNNING',
    });

    expect(startRunScript).toHaveBeenCalledWith('w1');
    expect(stopRunScript).toHaveBeenCalledWith('w1');
    expect(getRunScriptStatus).toHaveBeenCalledWith('w1');
  });

  it('returns trpc error when start/stop run script fails', async () => {
    const caller = createCaller({
      startRunScript: async () => ({ success: false, error: 'start failed' }),
      stopRunScript: async () => ({ success: false, error: 'stop failed' }),
    });

    await expect(caller.startRunScript({ workspaceId: 'w1' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    await expect(caller.stopRunScript({ workspaceId: 'w1' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
