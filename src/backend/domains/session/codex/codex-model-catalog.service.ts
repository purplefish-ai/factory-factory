import { SessionOperationError } from '@/backend/domains/session/codex/errors';
import {
  type CodexModel,
  CodexModelListResponseSchema,
} from '@/backend/domains/session/codex/schemas';
import {
  type CodexAppServerManager,
  codexAppServerManager,
} from '@/backend/domains/session/runtime/codex-app-server-manager';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('codex-model-catalog');

const MODEL_LIST_PAGE_LIMIT = 100;
const MODEL_LIST_MAX_PAGES = 20;
const MODEL_LIST_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedModelList {
  fetchedAt: number;
  models: CodexModel[];
}

export class CodexModelCatalogService {
  private cache: CachedModelList | null = null;

  constructor(private readonly manager: CodexAppServerManager = codexAppServerManager) {}

  invalidate(): void {
    this.cache = null;
  }

  async listModels(options?: { forceRefresh?: boolean }): Promise<CodexModel[]> {
    const now = Date.now();
    if (
      !options?.forceRefresh &&
      this.cache &&
      now - this.cache.fetchedAt < MODEL_LIST_CACHE_TTL_MS
    ) {
      return this.cache.models;
    }

    try {
      const models = await this.fetchModelPages();
      this.cache = {
        fetchedAt: now,
        models,
      };
      return models;
    } catch (error) {
      if (this.cache) {
        logger.warn('Failed to refresh Codex model catalog, using cached data', {
          error: error instanceof Error ? error.message : String(error),
          cachedModelCount: this.cache.models.length,
        });
        return this.cache.models;
      }
      throw error;
    }
  }

  private async fetchModelPages(): Promise<CodexModel[]> {
    const collected: CodexModel[] = [];
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      const rawResponse = await this.manager.request('model/list', {
        limit: MODEL_LIST_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      const parsed = CodexModelListResponseSchema.safeParse(rawResponse);
      if (!parsed.success) {
        throw new SessionOperationError('Codex model/list returned invalid payload', {
          code: 'CODEX_MODEL_LIST_INVALID_PAYLOAD',
          metadata: {
            issues: parsed.error.issues,
          },
          retryable: true,
        });
      }

      collected.push(...parsed.data.data);
      cursor = parsed.data.nextCursor;
      pageCount += 1;
    } while (cursor && pageCount < MODEL_LIST_MAX_PAGES);

    if (cursor) {
      logger.warn('Codex model/list pagination capped before completion', {
        pageCount,
      });
    }

    return dedupeAndSortModels(collected);
  }
}

function dedupeAndSortModels(models: CodexModel[]): CodexModel[] {
  const byModel = new Map<string, CodexModel>();
  for (const model of models) {
    if (!byModel.has(model.model)) {
      byModel.set(model.model, model);
    }
  }

  return [...byModel.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) {
      return a.isDefault ? -1 : 1;
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

export const codexModelCatalogService = new CodexModelCatalogService();
