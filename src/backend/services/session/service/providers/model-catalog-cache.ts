const CACHE_TTL_MS = 30_000;

export class ModelCatalogCache<TCatalog> {
  private cached: { models: TCatalog; fetchedAtMs: number } | null = null;
  private request: Promise<TCatalog> | null = null;

  constructor(private readonly dependencies: { fetchModels: () => Promise<TCatalog> }) {}

  async getModels(): Promise<TCatalog> {
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
