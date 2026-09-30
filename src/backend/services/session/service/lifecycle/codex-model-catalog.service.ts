import type { fetchCodexModelCatalogFromAppServer } from '@/backend/services/session/service/acp';
import { ModelCatalogCache } from './model-catalog-cache';

type CodexModelCatalog = Awaited<ReturnType<typeof fetchCodexModelCatalogFromAppServer>>;

export class CodexModelCatalogService extends ModelCatalogCache<CodexModelCatalog> {}
