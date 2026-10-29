import type { fetchCodexModelCatalogFromAppServer } from '@/backend/services/session/service/acp';
import { ModelCatalogCache } from './model-catalog-cache';

type CodexModelCatalog = Awaited<ReturnType<typeof fetchCodexModelCatalogFromAppServer>>;

export class CodexModelCatalogService {
  private readonly accounts = new Map<string, ModelCatalogCache<CodexModelCatalog>>();
  constructor(
    private readonly dependencies: {
      fetchModels(accountId?: string): Promise<CodexModelCatalog>;
      resolveAccountId?(accountId?: string): Promise<string>;
    }
  ) {}
  async getModels(accountId?: string): Promise<CodexModelCatalog> {
    if (this.dependencies.resolveAccountId) {
      accountId = await this.dependencies.resolveAccountId(accountId);
    }
    const key = accountId ?? 'auto';
    let cache = this.accounts.get(key);
    if (!cache) {
      cache = new ModelCatalogCache({
        fetchModels: () => this.dependencies.fetchModels(accountId),
      });
      this.accounts.set(key, cache);
    }
    return cache.getModels();
  }
}
