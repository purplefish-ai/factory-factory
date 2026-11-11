import { createLogger } from '@/backend/services/logger.service';
import { withTimeout } from '@/backend/services/session/service/acp/acp-runtime-spawn';

const logger = createLogger('model-catalog-cache');
const CACHE_FRESH_MS = 5 * 60_000;
const REFRESH_RETRY_MS = 30_000;

export class ModelCatalogCache<TCatalog> {
  private cached: { models: TCatalog; fetchedAtMs: number } | null = null;
  private request: Promise<TCatalog> | null = null;
  private refreshAfter = 0;
  private readonly lifetimes = new Set<Promise<void>>();
  private readonly cancellation = new AbortController();

  constructor(
    private readonly dependencies: {
      fetchModels: (
        signal?: AbortSignal,
        retainLifetime?: (drained: Promise<void>) => void
      ) => Promise<TCatalog>;
    }
  ) {}

  async stop(): Promise<void> {
    this.cancellation.abort(new Error('Model catalog discovery stopped'));
    await withTimeout({
      promise: Promise.resolve(this.request)
        .catch(() => undefined)
        .then(async () => {
          await Promise.all([...this.lifetimes]);
        }),
      timeoutMs: 7000,
      description: 'model catalog shutdown',
    });
  }

  async getModels(): Promise<TCatalog> {
    this.cancellation.signal.throwIfAborted();
    if (this.cached) {
      if (
        Date.now() - this.cached.fetchedAtMs >= CACHE_FRESH_MS &&
        Date.now() >= this.refreshAfter &&
        this.lifetimes.size === 0
      ) {
        void this.refresh().catch(() => undefined);
      }
      return structuredClone(this.cached.models);
    }
    return structuredClone(await this.refresh());
  }

  private retainLifetime = (drained: Promise<void>): void => {
    this.lifetimes.add(drained);
    void drained.then(
      () => {
        this.lifetimes.delete(drained);
      },
      () => {
        logger.warn('Model catalog drain failed; retaining admission');
      }
    );
  };

  private refresh(): Promise<TCatalog> {
    if (!this.request && this.lifetimes.size > 0) {
      return Promise.reject(new Error('Model catalog discovery is busy; retry shortly'));
    }
    this.request ??= Promise.resolve()
      .then(() => {
        this.cancellation.signal.throwIfAborted();
        return this.dependencies.fetchModels(this.cancellation.signal, this.retainLifetime);
      })
      .then((models) => {
        this.cancellation.signal.throwIfAborted();
        this.cached = { models: structuredClone(models), fetchedAtMs: Date.now() };
        this.refreshAfter = 0;
        return this.cached.models;
      })
      .catch((error: unknown) => {
        if (this.cached && !this.cancellation.signal.aborted) {
          logger.warn('Model catalog background refresh failed');
          this.refreshAfter = Date.now() + REFRESH_RETRY_MS;
        }
        throw error;
      })
      .finally(() => {
        this.request = null;
      });
    return this.request;
  }
}
