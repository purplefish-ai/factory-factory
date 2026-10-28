import './workspace-init.test-harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FactoryConfigService, startupScriptService } from '@/backend/services/run-script';
import { sessionDataService, sessionLifecycleService } from '@/backend/services/session';
import { workspaceStateMachine } from '@/backend/services/workspace';
import { SessionStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  clearWorkspaceInitOrchestratorStateForTests,
  initializeWorkspaceWorktree,
} from './workspace-init.orchestrator';
import { WORKSPACE_ID, setupHappyPath } from './workspace-init.test-harness';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectAgentNotStarted() {
  // Drain resolved startup reads while the script/readiness barrier remains held.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(sessionDataService.findAgentSessionsByWorkspaceId).not.toHaveBeenCalled();
  expect(sessionLifecycleService.startSession).not.toHaveBeenCalled();
}

describe('workspace initialization startup order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWorkspaceInitOrchestratorStateForTests();
    setupHappyPath();
    vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
      unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
    ]);
  });

  it('waits for both setup phases and the ready transition before starting the agent', async () => {
    vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
      unsafeCoerce({ scripts: { setup: './setup.sh', run: null, cleanup: null } })
    );
    vi.mocked(startupScriptService.hasStartupScript).mockReturnValue(true);
    const setupEntered = deferred<void>();
    const setupFinished = deferred<{ success: boolean }>();
    const startupEntered = deferred<void>();
    const startupFinished = deferred<{ success: boolean }>();
    const readyEntered = deferred<void>();
    const readyFinished = deferred<Awaited<ReturnType<typeof workspaceStateMachine.markReady>>>();
    vi.mocked(startupScriptService.runStartupScript)
      .mockImplementationOnce(() => {
        setupEntered.resolve();
        return setupFinished.promise as ReturnType<typeof startupScriptService.runStartupScript>;
      })
      .mockImplementationOnce(() => {
        startupEntered.resolve();
        return startupFinished.promise as ReturnType<typeof startupScriptService.runStartupScript>;
      });
    vi.mocked(workspaceStateMachine.markReady).mockImplementation(() => {
      readyEntered.resolve();
      return readyFinished.promise;
    });

    const initialization = initializeWorkspaceWorktree(WORKSPACE_ID);
    try {
      await setupEntered.promise;
      await expectAgentNotStarted();
      setupFinished.resolve({ success: true });
      await startupEntered.promise;
      await expectAgentNotStarted();
      startupFinished.resolve({ success: true });
      await readyEntered.promise;
      await expectAgentNotStarted();
    } finally {
      setupFinished.resolve({ success: true });
      startupFinished.resolve({ success: true });
      readyFinished.resolve(unsafeCoerce({}));
      await initialization;
    }
    expect(sessionLifecycleService.startSession).toHaveBeenCalledWith('session-1', {
      initialPrompt: '',
      startupModePreset: 'non_interactive',
    });
  });

  it('waits for readiness before starting an agent when no scripts are configured', async () => {
    const readyEntered = deferred<void>();
    const readyFinished = deferred<Awaited<ReturnType<typeof workspaceStateMachine.markReady>>>();
    vi.mocked(workspaceStateMachine.markReady).mockImplementation(() => {
      readyEntered.resolve();
      return readyFinished.promise;
    });

    const initialization = initializeWorkspaceWorktree(WORKSPACE_ID);
    try {
      await readyEntered.promise;
      await expectAgentNotStarted();
    } finally {
      readyFinished.resolve(unsafeCoerce({}));
      await initialization;
    }
    expect(sessionLifecycleService.startSession).toHaveBeenCalledTimes(1);
  });

  it('starts the agent after a setup warning has been persisted', async () => {
    vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
      unsafeCoerce({ scripts: { setup: './setup.sh', run: null, cleanup: null } })
    );
    vi.mocked(startupScriptService.runStartupScript).mockResolvedValue(
      unsafeCoerce({ success: false, errorMessage: 'setup failed' })
    );
    const warningEntered = deferred<void>();
    const warningFinished =
      deferred<Awaited<ReturnType<typeof workspaceStateMachine.markReadyWithWarning>>>();
    vi.mocked(workspaceStateMachine.markReadyWithWarning).mockImplementation(() => {
      warningEntered.resolve();
      return warningFinished.promise;
    });

    const initialization = initializeWorkspaceWorktree(WORKSPACE_ID);
    try {
      await warningEntered.promise;
      await expectAgentNotStarted();
    } finally {
      warningFinished.resolve(unsafeCoerce({}));
      await initialization;
    }
    expect(workspaceStateMachine.markReadyWithWarning).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'setup failed'
    );
    expect(sessionLifecycleService.startSession).toHaveBeenCalledTimes(1);
  });
});
