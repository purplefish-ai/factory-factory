import { afterEach, expect, it, vi } from 'vitest';
import { codexAccountService } from '@/backend/services/codex-accounts';
import * as acp from '@/backend/services/session/service/acp';
import { codexModelCatalogService } from './session-core-services';

afterEach(() => vi.restoreAllMocks());

it('uses one model probe per enabled account and no native probes for warm catalog reads', async () => {
  const accountIds = ['catalog-composition-a', 'catalog-composition-b'];
  const list = vi.spyOn(codexAccountService, 'getEnabledAccountIds').mockResolvedValue(accountIds);
  const summaries = vi.spyOn(codexAccountService, 'getAccounts');
  const previews = vi.spyOn(codexAccountService, 'getPreviewRuntimeContext');
  const runtime = vi
    .spyOn(codexAccountService, 'getRuntimeContext')
    .mockImplementation((accountId = 'native') =>
      Promise.resolve({
        accountId,
        homeDir: `/profiles/${accountId}`,
        sessionsDir: `/profiles/${accountId}/sessions`,
        env: { CODEX_HOME: `/profiles/${accountId}` },
      })
    );
  const fetchModels = vi
    .spyOn(acp, 'fetchCodexModelCatalogFromAppServer')
    .mockImplementation((options) =>
      Promise.resolve([
        {
          id: `${options?.env?.CODEX_HOME}-model`,
          displayName: 'Account model',
          description: '',
          isDefault: true,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [],
          inputModalities: ['text'],
        },
      ])
    );
  const first = await codexModelCatalogService.getModels();
  expect(first.map((model) => model.id)).toEqual(accountIds.map((id) => `/profiles/${id}-model`));
  expect(runtime.mock.calls).toEqual(accountIds.map((id) => [id]));
  expect(fetchModels).toHaveBeenCalledTimes(2);
  await expect(codexModelCatalogService.getModels()).resolves.toEqual(first);
  await codexModelCatalogService.getModels(accountIds[0]);
  expect(list).toHaveBeenCalledTimes(2);
  expect(runtime).toHaveBeenCalledTimes(2);
  expect(fetchModels).toHaveBeenCalledTimes(2);
  expect(summaries).not.toHaveBeenCalled();
  expect(previews).not.toHaveBeenCalled();
});
