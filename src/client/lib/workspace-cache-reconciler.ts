import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import {
  projectSnapshotToWorkspace,
  type ProjectWorkspace,
} from '@/client/lib/snapshot-to-workspace';
import { trpc } from '@/client/lib/trpc';
import type { SnapshotServerMessage, WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';

export interface ProjectWorkspaceCache {
  workspaces: ProjectWorkspace[];
  reviewCount: number;
}

export interface WorkspaceConnection {
  readonly identity: symbol;
}

/** Coordinates the existing query cache; it is not another rendered data store. */
export class ProjectWorkspaceCacheReconciler {
  private connection: WorkspaceConnection | undefined;
  private epoch = Symbol('http');
  private entries: Map<string, WorkspaceSnapshotEntry> | undefined;
  private reviewCount: number | undefined;
  private readonly httpResults = new WeakMap<
    object,
    { epoch: symbol; data: ProjectWorkspaceCache }
  >();
  readonly queryKey;

  constructor(
    private readonly queryClient: QueryClient,
    private readonly projectId: string
  ) {
    this.queryKey = getQueryKey(trpc.workspace.listForProject, { projectId }, 'query');
  }

  beginConnection(): WorkspaceConnection {
    if (this.connection) {
      this.epoch = Symbol('connection');
    }
    this.connection = { identity: this.epoch };
    this.entries = undefined;
    this.reviewCount = undefined;
    return this.connection;
  }

  retireConnection(connection: WorkspaceConnection): boolean {
    if (this.connection !== connection) {
      return false;
    }
    this.connection = undefined;
    this.epoch = Symbol('http');
    this.entries = undefined;
    this.reviewCount = undefined;
    return true;
  }

  isCurrent(connection: WorkspaceConnection): boolean {
    return this.connection === connection;
  }

  async fetch(
    fetchWorkspaces: (signal: AbortSignal) => Promise<ProjectWorkspaceCache>,
    signal: AbortSignal
  ): Promise<ProjectWorkspaceCache> {
    const epoch = this.epoch;
    const data = await fetchWorkspaces(signal);
    this.httpResults.set(data, { epoch, data });
    return data;
  }

  /** Query.setData calls this synchronously at its actual success commit. */
  readonly structuralSharing = (previous: unknown, next: unknown): unknown => {
    const http = typeof next === 'object' && next !== null ? this.httpResults.get(next) : undefined;
    if (!http) {
      return next;
    }
    this.httpResults.delete(http.data);
    if (http.epoch !== this.epoch) {
      return previous;
    }
    if (!this.entries) {
      return http.data;
    }

    // Read the current cache, not the value captured when HTTP began/resolved.
    const current = this.queryClient.getQueryData<ProjectWorkspaceCache>(this.queryKey);
    const incoming = new Map(http.data.workspaces.map((workspace) => [workspace.id, workspace]));
    const rows =
      current?.workspaces ??
      [...this.entries.values()].map((entry) => projectSnapshotToWorkspace(entry));
    return {
      workspaces: rows.map((workspace) => {
        const entry = this.entries?.get(workspace.id);
        // Explicit optimistic additions/removals retain their existing semantics.
        if (!entry) {
          return workspace;
        }
        const metadata = incoming.get(workspace.id);
        return projectSnapshotToWorkspace(
          entry,
          metadata ? { ...workspace, ...metadata } : workspace
        );
      }),
      reviewCount: this.reviewCount ?? http.data.reviewCount,
    };
  };

  accepts(connection: WorkspaceConnection, message: SnapshotServerMessage): boolean {
    if (!this.isCurrent(connection)) {
      return false;
    }
    if (message.type === 'snapshot_full' && message.projectId !== this.projectId) {
      return false;
    }
    if (message.type === 'snapshot_changed' && message.entry.projectId !== this.projectId) {
      return false;
    }
    return true;
  }

  apply(connection: WorkspaceConnection, message: SnapshotServerMessage): boolean {
    if (!this.accepts(connection, message)) {
      return false;
    }
    if (message.type === 'snapshot_full') {
      this.entries = new Map(message.entries.map((entry) => [entry.workspaceId, entry]));
    } else if (message.type === 'snapshot_changed') {
      this.entries?.set(message.entry.workspaceId, message.entry);
    } else {
      this.entries?.delete(message.workspaceId);
    }
    if (message.reviewCount !== undefined) {
      this.reviewCount = message.reviewCount;
    }
    this.queryClient.setQueryData<ProjectWorkspaceCache>(this.queryKey, (previous) => {
      if (message.type === 'snapshot_full') {
        const existing = new Map(
          previous?.workspaces.map((workspace) => [workspace.id, workspace])
        );
        return {
          workspaces: message.entries.map((entry) =>
            projectSnapshotToWorkspace(entry, existing.get(entry.workspaceId))
          ),
          reviewCount: message.reviewCount ?? previous?.reviewCount ?? 0,
        };
      }
      if (message.type === 'snapshot_removed') {
        return (
          previous && {
            workspaces: previous.workspaces.filter(
              (workspace) => workspace.id !== message.workspaceId
            ),
            reviewCount: message.reviewCount ?? previous.reviewCount,
          }
        );
      }
      const rows = previous?.workspaces ?? [];
      const index = rows.findIndex((workspace) => workspace.id === message.entry.workspaceId);
      const mapped = projectSnapshotToWorkspace(message.entry, rows[index]);
      const workspaces = [...rows];
      if (index < 0) {
        workspaces.push(mapped);
      } else {
        workspaces[index] = mapped;
      }
      return { workspaces, reviewCount: message.reviewCount ?? previous?.reviewCount ?? 0 };
    });
    return true;
  }
}

const reconcilers = new WeakMap<QueryClient, Map<string, ProjectWorkspaceCacheReconciler>>();

export function getProjectWorkspaceCacheReconciler(
  queryClient: QueryClient,
  projectId: string
): ProjectWorkspaceCacheReconciler {
  let projects = reconcilers.get(queryClient);
  if (!projects) {
    projects = new Map();
    reconcilers.set(queryClient, projects);
  }
  let owner = projects.get(projectId);
  if (!owner) {
    owner = new ProjectWorkspaceCacheReconciler(queryClient, projectId);
    projects.set(projectId, owner);
  }
  return owner;
}

/** Shared by every ordinary list query, including metadata-repair refetches. */
export function projectWorkspaceQueryOptions(
  queryClient: QueryClient,
  projectId: string,
  fetchWorkspaces: (signal: AbortSignal) => Promise<ProjectWorkspaceCache>
) {
  const owner = getProjectWorkspaceCacheReconciler(queryClient, projectId);
  return queryOptions({
    queryKey: owner.queryKey,
    queryFn: ({ signal }) => owner.fetch(fetchWorkspaces, signal),
    structuralSharing: owner.structuralSharing,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}
