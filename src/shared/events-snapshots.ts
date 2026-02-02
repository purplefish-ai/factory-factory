import { z } from 'zod';

const WorkspaceStatusSchema = z.enum(['NEW', 'PROVISIONING', 'READY', 'FAILED', 'ARCHIVED']);

const ProjectListItemSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    slug: z.string().optional(),
    repoPath: z.string().optional(),
    defaultBranch: z.string().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough();

const WorkspaceListItemSchema = z
  .object({
    id: z.string(),
    status: WorkspaceStatusSchema,
    name: z.string().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough();

const SessionListItemSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
  })
  .passthrough();

const ProjectSummaryWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  branchName: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  prState: z.string().nullable(),
  prCiStatus: z.string().nullable(),
  isWorking: z.boolean(),
  gitStats: z
    .object({
      total: z.number(),
      additions: z.number(),
      deletions: z.number(),
      hasUncommitted: z.boolean(),
    })
    .nullable(),
  lastActivityAt: z.string().nullable(),
});

export const ProjectListSnapshotSchema = z.object({
  type: z.literal('project_list_snapshot'),
  projects: z.array(ProjectListItemSchema),
});

export const ProjectSummarySnapshotSchema = z.object({
  type: z.literal('project_summary_snapshot'),
  projectId: z.string(),
  workspaces: z.array(ProjectSummaryWorkspaceSchema),
  reviewCount: z.number(),
});

export const WorkspaceListSnapshotSchema = z.object({
  type: z.literal('workspace_list_snapshot'),
  projectId: z.string(),
  workspaces: z.array(WorkspaceListItemSchema),
});

export const KanbanSnapshotSchema = z.object({
  type: z.literal('kanban_snapshot'),
  projectId: z.string(),
  workspaces: z.array(WorkspaceListItemSchema),
});

export const WorkspaceDetailSnapshotSchema = z.object({
  type: z.literal('workspace_detail_snapshot'),
  workspaceId: z.string(),
  workspace: WorkspaceListItemSchema.passthrough(),
});

export const SessionListSnapshotSchema = z.object({
  type: z.literal('session_list_snapshot'),
  workspaceId: z.string(),
  sessions: z.array(SessionListItemSchema),
});

export const WorkspaceInitStatusSnapshotSchema = z.object({
  type: z.literal('workspace_init_status_snapshot'),
  workspaceId: z.string(),
  status: WorkspaceStatusSchema,
  initErrorMessage: z.string().nullable(),
  initStartedAt: z.string().nullable(),
  initCompletedAt: z.string().nullable(),
  hasStartupScript: z.boolean(),
});

export const ReviewsSnapshotSchema = z.object({
  type: z.literal('reviews_snapshot'),
  prs: z.array(z.unknown()),
  health: z.object({ isInstalled: z.boolean(), isAuthenticated: z.boolean() }),
  error: z.string().nullable(),
});

export const AdminStatsSnapshotSchema = z.object({
  type: z.literal('admin_stats_snapshot'),
  stats: z.unknown(),
});

export const AdminProcessesSnapshotSchema = z.object({
  type: z.literal('admin_processes_snapshot'),
  processes: z.unknown(),
});

export const EventsSnapshotSchema = z.discriminatedUnion('type', [
  ProjectListSnapshotSchema,
  ProjectSummarySnapshotSchema,
  WorkspaceListSnapshotSchema,
  KanbanSnapshotSchema,
  WorkspaceDetailSnapshotSchema,
  SessionListSnapshotSchema,
  WorkspaceInitStatusSnapshotSchema,
  ReviewsSnapshotSchema,
  AdminStatsSnapshotSchema,
  AdminProcessesSnapshotSchema,
]);

export type EventsSnapshot = z.infer<typeof EventsSnapshotSchema>;
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type ProjectListSnapshot = z.infer<typeof ProjectListSnapshotSchema>;
export type ProjectSummarySnapshot = z.infer<typeof ProjectSummarySnapshotSchema>;
export type WorkspaceListSnapshot = z.infer<typeof WorkspaceListSnapshotSchema>;
export type KanbanSnapshot = z.infer<typeof KanbanSnapshotSchema>;
export type WorkspaceDetailSnapshot = z.infer<typeof WorkspaceDetailSnapshotSchema>;
export type SessionListSnapshot = z.infer<typeof SessionListSnapshotSchema>;
export type WorkspaceInitStatusSnapshot = z.infer<typeof WorkspaceInitStatusSnapshotSchema>;
export type ReviewsSnapshot = z.infer<typeof ReviewsSnapshotSchema>;
export type AdminStatsSnapshot = z.infer<typeof AdminStatsSnapshotSchema>;
export type AdminProcessesSnapshot = z.infer<typeof AdminProcessesSnapshotSchema>;
