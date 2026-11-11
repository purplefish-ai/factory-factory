const CACHE_FRESH_MS = 5 * 60_000;
const REFRESH_RETRY_MS = 30_000;

export class ModelCatalogCache<TCatalog> {
  private cached: { models: TCatalog; fetchedAtMs: number } | null = null;
  private request: Promise<TCatalog> | null = null;
  private refreshAfter = 0;

  constructor(private readonly dependencies: { fetchModels: () => Promise<TCatalog> }) {}

  async getModels(): Promise<TCatalog> {
    if (this.cached) {
      if (
        Date.now() - this.cached.fetchedAtMs >= CACHE_FRESH_MS &&
        Date.now() >= this.refreshAfter
      ) {
        void this.refresh().catch(() => {
          this.refreshAfter = Date.now() + REFRESH_RETRY_MS;
        });
      }
      return structuredClone(this.cached.models);
    }
    return structuredClone(await this.refresh());
  }

  private refresh(): Promise<TCatalog> {
    this.request ??= Promise.resolve()
      .then(() => this.dependencies.fetchModels())
      .then((models) => {
        this.cached = { models: structuredClone(models), fetchedAtMs: Date.now() };
        this.refreshAfter = 0;
        return this.cached.models;
      })
      .finally(() => {
        this.request = null;
      });
    return this.request;
  }
}
