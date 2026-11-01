import { expect, it, vi } from 'vitest';
import { createDefaultApplicationDependencies } from './app-context';
import { codexAccountService } from './services/codex-accounts';
it('validates frozen event accounts through the current application graph without reserving again', async () => {
  const { services } = createDefaultApplicationDependencies();
  const validatedAccounts: (string | undefined)[] = [];
  const fallback = vi
    .spyOn(codexAccountService, 'getRuntimeContext')
    .mockRejectedValue(new Error('Wrong singleton'));
  services.codexAccountService = Object.assign({}, services.codexAccountService, {
    getEnabledAccountIds: () => Promise.resolve(['frozen']),
    getRuntimeContext: (id?: string) => {
      validatedAccounts.push(id);
      return Promise.reject(new Error('Private authentication cause'));
    },
    withAccountReservation: () => {
      throw new Error('Unexpected nested reservation');
    },
  });
  try {
    await expect(
      services.sessionDataService.createEventSessionOnce({
        id: 'session',
        workspaceId: 'workspace',
        runId: 'run',
        execution: {
          version: 1,
          provider: 'CODEX',
          model: 'gpt-5.4',
          reasoningEffort: 'high',
          codexAccountId: 'frozen',
          startupModePreset: 'non_interactive',
          accessMode: 'workspace-write',
          planModeEnabled: false,
        },
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Frozen Codex account is unavailable',
    });
    expect(validatedAccounts).toEqual(['frozen']);
    expect(fallback).not.toHaveBeenCalled();
  } finally {
    fallback.mockRestore();
  }
});
