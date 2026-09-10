import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startupScriptService } from '@/backend/services/run-script';

vi.mock('@/backend/services/workspace', () => ({
  workspaceStateMachine: { markReady: vi.fn(), markReadyWithWarning: vi.fn() },
}));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executeStartupScriptPipeline } from './workspace-init-script-pipeline';

it.each([true, false])(
  'retains every startup phase and clears previous attempts (setup: %s)',
  async (setup) => {
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'ff-pipeline-output-'));
    let output = 'previous attempt\n';
    startupScriptService.configure({
      workspace: {
        markReady: vi.fn(),
        markFailed: vi.fn(),
        clearInitOutput: () => {
          output = '';
          return Promise.resolve();
        },
        appendInitOutput: (_id: string, chunk: string) => {
          output += chunk;
          return Promise.resolve();
        },
        setInitScriptPid: vi.fn().mockResolvedValue(undefined),
        clearInitScriptPid: vi.fn().mockResolvedValue(undefined),
      },
    });
    const context = {
      workspaceId: 'pipeline-output',
      worktreePath,
      workspaceWithProject: {
        id: 'pipeline-output',
        worktreePath,
        project: { startupScriptCommand: 'echo project startup', startupScriptPath: null },
      },
      factoryConfig: setup ? { scripts: { setup: 'echo factory setup' } } : null,
    } as Parameters<typeof executeStartupScriptPipeline>[0];
    try {
      await executeStartupScriptPipeline(context);
      expect(output).toBe(setup ? 'factory setup\nproject startup\n' : 'project startup\n');
      await executeStartupScriptPipeline(context);
      expect(output).toBe(setup ? 'factory setup\nproject startup\n' : 'project startup\n');
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  }
);
