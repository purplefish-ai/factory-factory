import type { fetchCodexModelCatalogFromAppServer } from '@/backend/services/session/service/acp';

const CACHE_TTL_MS = 30_000;
type CodexModelCatalog = Awaited<ReturnType<typeof fetchCodexModelCatalogFromAppServer>>;

export class CodexModelCatalogService {
  private cached: { models: CodexModelCatalog; fetchedAtMs: number } | null = null;
  private request: Promise<CodexModelCatalog> | null = null;

  constructor(private readonly dependencies: { fetchModels: () => Promise<CodexModelCatalog> }) {}

  async getModels(): Promise<CodexModelCatalog> {
    if (this.cached && Date.now() - this.cached.fetchedAtMs < CACHE_TTL_MS) {
      return structuredClone(this.cached.models);
    }

    this.request ??= Promise.resolve()
      .then(() => this.dependencies.fetchModels())
      .then((models) => {
        this.cached = { models: structuredClone(models), fetchedAtMs: Date.now() };
        return this.cached.models;
      })
      .finally(() => {
        this.request = null;
      });

    return structuredClone(await this.request);
  }
}
