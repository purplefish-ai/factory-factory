import { z } from 'zod';
import { prisma } from '@/backend/db';
import type { Prisma } from '@prisma-gen/client';
import {
  type FlattenedWorkspaceRow,
  flattenWorkspaceRow,
  type WorkspaceSideTableInclude,
  workspaceSideTables,
} from './workspace.accessor';

/**
 * Narrow workspace reads for client detail and polled endpoints. The full
 * `findById` row carries `creationMetadata` (which retains base64 initial
 * attachments after init), the startup-script log and session provider
 * metadata; these reads leave out what their callers never use.
 */

type WorkspaceDetailRow = FlattenedWorkspaceRow<
  Prisma.WorkspaceGetPayload<{
    omit: { initOutput: true };
    include: {
      agentSessions: { omit: { providerMetadata: true } };
      terminalSessions: true;
    } & WorkspaceSideTableInclude;
  }>
>;

/** The client-facing workspace detail: no init log, provider metadata or attachments. */
export type WorkspaceDetail = Omit<WorkspaceDetailRow, 'creationMetadata'> & {
  initialPrompt: string | null;
};

export type WorkspaceWorktreeContext = {
  id: string;
  worktreePath: string | null;
  project: { defaultBranch: string };
};

const workspaceInitStatusSelect = {
  id: true,
  projectId: true,
  status: true,
  creationSource: true,
  worktreePath: true,
  initErrorMessage: true,
  initOutput: true,
  initStartedAt: true,
  initCompletedAt: true,
  initRetryCount: true,
  project: { select: { startupScriptCommand: true, startupScriptPath: true } },
} satisfies Prisma.WorkspaceSelect;

export type WorkspaceInitStatusRow = Prisma.WorkspaceGetPayload<{
  select: typeof workspaceInitStatusSelect;
}>;

const initialPromptMetadataSchema = z.object({ initialPrompt: z.string() });

function readInitialPrompt(creationMetadata: Prisma.JsonValue): string | null {
  const parsed = initialPromptMetadataSchema.safeParse(creationMetadata);
  return parsed.success ? parsed.data.initialPrompt : null;
}

class WorkspaceDetailReadAccessor {
  /**
   * The workspace detail served to clients: the full flattened row minus the
   * init log and session provider metadata, with `creationMetadata` reduced
   * to the initial prompt the details dialog shows.
   */
  async findDetailById(id: string): Promise<WorkspaceDetail | null> {
    const row = await prisma.workspace.findUnique({
      where: { id },
      omit: { initOutput: true },
      include: {
        agentSessions: { omit: { providerMetadata: true } },
        terminalSessions: true,
        ...workspaceSideTables,
      },
    });
    if (!row) {
      return null;
    }
    const { creationMetadata, ...rest } = flattenWorkspaceRow(row);
    return { ...rest, initialPrompt: readInitialPrompt(creationMetadata) };
  }

  /** The worktree path and project default branch, for git and file reads. */
  findWorktreeContext(id: string): Promise<WorkspaceWorktreeContext | null> {
    return prisma.workspace.findUnique({
      where: { id },
      select: {
        id: true,
        worktreePath: true,
        project: { select: { defaultBranch: true } },
      },
    });
  }

  /** The fields the init-status poll reports and derives retry availability from. */
  findInitStatus(id: string): Promise<WorkspaceInitStatusRow | null> {
    return prisma.workspace.findUnique({
      where: { id },
      select: workspaceInitStatusSelect,
    });
  }
}

export const workspaceDetailReadAccessor = new WorkspaceDetailReadAccessor();
