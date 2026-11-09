import { z } from 'zod';
import { prisma } from '@/backend/db';
import { readWorkspaceInitialPrompt } from '@/shared/workspace-initial-prompt';
import type { Prisma } from '@prisma-gen/client';
import {
  type FlattenedWorkspaceRow,
  flattenWorkspaceRow,
  type WorkspaceSideTableInclude,
  workspaceSessionsWithoutBlobs,
  workspaceSideTables,
} from './workspace.accessor';

/**
 * Narrow workspace reads for client detail and polled endpoints. These reads
 * leave out what their callers never use: the startup-script log, session
 * provider metadata, and `creationMetadata` (which retains base64 initial
 * attachments after init) beyond the initial prompt.
 */

type WorkspaceDetailRow = FlattenedWorkspaceRow<
  Prisma.WorkspaceGetPayload<{
    omit: { initOutput: true };
    include: typeof workspaceSessionsWithoutBlobs & WorkspaceSideTableInclude;
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

const creationMetadataSchema = z.record(z.string(), z.unknown());

export type WorkspaceInitialMessageContext = {
  id: string;
  parentWorkspaceId: string | null;
  creationMetadata: Record<string, unknown> | null;
};

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
      include: { ...workspaceSessionsWithoutBlobs, ...workspaceSideTables },
    });
    if (!row) {
      return null;
    }
    const { creationMetadata, ...rest } = flattenWorkspaceRow(row);
    return { ...rest, initialPrompt: readWorkspaceInitialPrompt(creationMetadata) };
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

  /**
   * The creation metadata carrying the initial prompt and base64 attachments,
   * for building the first message after initialization. Non-object metadata
   * reads as null.
   */
  async findInitialMessageContext(id: string): Promise<WorkspaceInitialMessageContext | null> {
    const row = await prisma.workspace.findUnique({
      where: { id },
      select: { id: true, parentWorkspaceId: true, creationMetadata: true },
    });
    if (!row) {
      return null;
    }
    const metadata = creationMetadataSchema.safeParse(row.creationMetadata);
    return { ...row, creationMetadata: metadata.success ? metadata.data : null };
  }
}

export const workspaceDetailReadAccessor = new WorkspaceDetailReadAccessor();
