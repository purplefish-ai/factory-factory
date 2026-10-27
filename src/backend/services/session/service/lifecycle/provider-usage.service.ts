import type { PlanUsageReading } from '@/backend/services/session/service/acp/provider-usage-normalizer';
import {
  providerPlanUsageSchema,
  type ProviderPlanUsage,
  type UsageProvider,
} from '@/shared/provider-usage';

const CACHE_TTL_MS = 30_000;

/** Account-level reads are shared by every workspace on this backend. */
export class ProviderUsageService {
  private readonly cache = new Map<
    UsageProvider,
    { value: ProviderPlanUsage; fetchedAt: number }
  >();
  private readonly requests = new Map<UsageProvider, Promise<ProviderPlanUsage>>();

  constructor(
    private readonly dependencies: {
      fetchUsage(provider: UsageProvider): Promise<PlanUsageReading>;
    }
  ) {}

  async getUsage(provider: UsageProvider): Promise<ProviderPlanUsage> {
    const cached = this.cache.get(provider);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return structuredClone(cached.value);
    }
    let request = this.requests.get(provider);
    if (!request) {
      request = Promise.resolve()
        .then(() => this.dependencies.fetchUsage(provider))
        .then((result) => {
          const value = providerPlanUsageSchema.parse({
            ...result,
            provider,
            updatedAt: new Date().toISOString(),
          });
          this.cache.set(provider, { value, fetchedAt: Date.now() });
          return value;
        })
        .catch((): ProviderPlanUsage => ({
          provider,
          status: 'error',
          windows: [],
          updatedAt: new Date().toISOString(),
          message: 'Could not refresh plan limits.',
        }))
        .finally(() => this.requests.delete(provider));
      this.requests.set(provider, request);
    }
    return structuredClone(await request);
  }
}
