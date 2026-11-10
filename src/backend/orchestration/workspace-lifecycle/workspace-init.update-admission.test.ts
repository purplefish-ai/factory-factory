// Register shared mocks before service or orchestrator imports.
import './workspace-init.test-harness';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applicationUpdateAdmission } from '@/backend/services/application-update-admission.service';
import { workspaceStateMachine, worktreeLifecycleService } from '@/backend/services/workspace';
import { deferred } from '@/test-utils/deferred';
import {
  clearWorkspaceInitOrchestratorStateForTests,
  recoverStaleProvisioningWorkspace,
} from './workspace-init.orchestrator';
import { WORKSPACE_ID, mockLogger } from './workspace-init.test-harness';

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkspaceInitOrchestratorStateForTests();
});
afterEach(() => applicationUpdateAdmission.release());

it('quietly skips stale recovery while update admission is closed', async () => {
  expect(applicationUpdateAdmission.tryClose(() => false)).toBe(true);
  await expect(
    recoverStaleProvisioningWorkspace(WORKSPACE_ID, 'Provisioning timed out')
  ).resolves.toBe(false);
  expect(worktreeLifecycleService.prepareStaleProvisioningRecovery).not.toHaveBeenCalled();
  expect(workspaceStateMachine.markFailed).not.toHaveBeenCalled();
  expect(mockLogger.warn).not.toHaveBeenCalled();
  expect(mockLogger.error).not.toHaveBeenCalled();
});

it('keeps admission open until an already-admitted recovery finishes', async () => {
  const cleanup = deferred<boolean>();
  vi.mocked(worktreeLifecycleService.prepareStaleProvisioningRecovery).mockReturnValueOnce(
    cleanup.promise
  );
  const recovery = recoverStaleProvisioningWorkspace(WORKSPACE_ID, 'Provisioning timed out');
  await vi.waitFor(() =>
    expect(worktreeLifecycleService.prepareStaleProvisioningRecovery).toHaveBeenCalledWith(
      WORKSPACE_ID
    )
  );
  expect(applicationUpdateAdmission.tryClose(() => false)).toBe(false);
  cleanup.resolve(true);
  await expect(recovery).resolves.toBe(true);
  expect(applicationUpdateAdmission.tryClose(() => false)).toBe(true);
});
