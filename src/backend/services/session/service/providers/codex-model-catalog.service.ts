import type { fetchCodexModelCatalogFromAppServer } from '@/backend/services/session/service/acp';
import { ModelCatalogCache } from './model-catalog-cache';

type CodexModelCatalog = Awaited<ReturnType<typeof fetchCodexModelCatalogFromAppServer>>;

export class CodexModelCatalogService {
  private readonly accounts = new Map<string, ModelCatalogCache<CodexModelCatalog>>();
  private stopped = false;
  constructor(
    private readonly dependencies: {
      fetchModels(
        accountId?: string,
        signal?: AbortSignal,
        retainLifetime?: (drained: Promise<void>) => void
      ): Promise<CodexModelCatalog>;
      resolveAccountId?(accountId?: string): Promise<string>;
      listAccountIds?(): Promise<string[]>;
    }
  ) {}
  private assertRunning(): void {
    if (this.stopped) {
      throw new Error('Model catalog discovery stopped');
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.accounts.values()].map((cache) => cache.stop()));
  }
  async getModels(accountId?: string): Promise<CodexModelCatalog> {
    this.assertRunning();
    if (accountId === undefined && this.dependencies.listAccountIds) {
      const ids = await this.dependencies.listAccountIds();
      this.assertRunning();
      return this.getAutoModels(ids);
    }
    if (this.dependencies.resolveAccountId) {
      accountId = await this.dependencies.resolveAccountId(accountId);
    }
    this.assertRunning();
    const key = accountId ?? 'auto';
    let cache = this.accounts.get(key);
    if (!cache) {
      cache = new ModelCatalogCache({
        fetchModels: (signal, retainLifetime) =>
          this.dependencies.fetchModels(accountId, signal, retainLifetime),
      });
      this.accounts.set(key, cache);
    }
    return cache.getModels();
  }
  private async getAutoModels(accountIds: string[]): Promise<CodexModelCatalog> {
    const results = await Promise.allSettled(accountIds.map((id) => this.getModels(id)));
    this.assertRunning();
    const available = results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    if (available.length === 0) {
      throw new Error('No enabled Codex account has an available model catalog');
    }
    return mergeAccountCatalogs(available);
  }
}

function mergeAccountCatalogs(catalogs: CodexModelCatalog[]): CodexModelCatalog {
  const models = new Map<string, CodexModelCatalog[number]>();
  for (const model of catalogs.flat()) {
    const existing = models.get(model.id);
    if (!existing) {
      models.set(model.id, model);
      continue;
    }
    const efforts = new Map(
      existing.supportedReasoningEfforts.map((effort) => [effort.reasoningEffort, effort])
    );
    for (const effort of model.supportedReasoningEfforts) {
      efforts.set(effort.reasoningEffort, effort);
    }
    existing.supportedReasoningEfforts = [...efforts.values()];
  }
  return [...models.values()];
}
