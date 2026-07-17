import type { workspaceDataService } from '@/backend/services/workspace';

/**
 * A workspace record that includes its associated project, with both guaranteed present.
 * Used by orchestrators that need workspace + project together.
 */
export type WorkspaceWithProject = Exclude<
  Awaited<ReturnType<typeof workspaceDataService.findByIdWithProject>>,
  null | undefined
>;
