import type { fetchClaudeModelCatalogFromAcp } from '@/backend/services/session/service/acp';
import { ModelCatalogCache } from './model-catalog-cache';

type ClaudeModelCatalog = Awaited<ReturnType<typeof fetchClaudeModelCatalogFromAcp>>;

export class ClaudeModelCatalogService extends ModelCatalogCache<ClaudeModelCatalog> {}
