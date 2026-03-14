import type { workspaceAccessor } from '@/backend/services/workspace';

/**
 * A workspace record that includes its associated project, with both guaranteed present.
 * Used by orchestrators that need workspace + project together.
 */
export type WorkspaceWithProject = Exclude<
  Awaited<ReturnType<typeof workspaceAccessor.findByIdWithProject>>,
  null | undefined
>;
