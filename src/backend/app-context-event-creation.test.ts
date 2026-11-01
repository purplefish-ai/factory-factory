import { expect, it, vi } from 'vitest';
import { createDefaultApplicationDependencies } from './app-context';
import { codexAccountService } from './services/codex-accounts';
it('validates frozen event accounts through the current application graph without reserving again', async () => {
  const { services } = createDefaultApplicationDependencies();
  const fallback = vi
    .spyOn(codexAccountService, 'getRuntimeContext')
    .mockRejectedValue(new Error('Wrong singleton'));
  services.codexAccountService = Object.assign({}, services.codexAccountService, {
    getEnabledAccountIds: () => Promise.resolve(['frozen']),
    getRuntimeContext: (id?: string) =>
      Promise.reject(new Error(`Graph account unavailable: ${id}`)),
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
    ).rejects.toThrow('Graph account unavailable: frozen');
  } finally {
    fallback.mockRestore();
  }
});
