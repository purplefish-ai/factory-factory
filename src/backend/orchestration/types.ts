import type { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';

/**
 * A workspace record that includes its associated project, with both guaranteed present.
 * Used by orchestrators that need workspace + project together.
 */
export type WorkspaceWithProject = Exclude<
  Awaited<ReturnType<typeof workspaceAccessor.findByIdWithProject>>,
  null | undefined
>;
