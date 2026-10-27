import {
  CancelledError,
  type Query,
  type QueryClient,
  queryOptions,
  replaceEqualDeep,
} from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { runInBackground } from '@/client/lib/background-task';
import {
  mergeProjectSnapshotIntoWorkspaceDetail,
  projectSnapshotToWorkspace,
  type WorkspaceDetail,
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
  private readonly initialEpoch = Symbol('http');
  private epoch = this.initialEpoch;
  private entries = new Map<string, WorkspaceSnapshotEntry>();
  private hasBaseline = false;
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
    if (this.connection || this.epoch !== this.initialEpoch) {
      this.epoch = Symbol('connection');
    }
    this.connection = { identity: this.epoch };
    this.entries.clear();
    this.hasBaseline = false;
    this.reviewCount = undefined;
    return this.connection;
  }

  retireConnection(connection: WorkspaceConnection): boolean {
    if (this.connection !== connection) {
      return false;
    }
    this.connection = undefined;
    this.epoch = Symbol('http');
    this.entries.clear();
    this.hasBaseline = false;
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
      return replaceEqualDeep(previous, next);
    }
    this.httpResults.delete(http.data);
    if (http.epoch !== this.epoch) {
      return previous;
    }
    if (!this.hasBaseline) {
      return replaceEqualDeep(previous, http.data);
    }

    // Read the current cache, not the value captured when HTTP began/resolved.
    const current = this.queryClient.getQueryData<ProjectWorkspaceCache>(this.queryKey);
    const incoming = new Map(http.data.workspaces.map((workspace) => [workspace.id, workspace]));
    const rows =
      current?.workspaces ??
      [...this.entries.values()].map((entry) => projectSnapshotToWorkspace(entry));
    const reconciled = {
      workspaces: rows.map((workspace) => {
        const entry = this.entries.get(workspace.id);
        // Explicit optimistic additions/removals retain their existing semantics.
        if (!entry) {
          return workspace;
        }
        const metadata = incoming.get(workspace.id);
        return projectSnapshotToWorkspace(
          entry,
          // Creation time belongs to the snapshot; retain its cached Date identity.
          metadata ? { ...workspace, ...metadata, createdAt: workspace.createdAt } : workspace
        );
      }),
      reviewCount: this.reviewCount ?? http.data.reviewCount,
    };
    return replaceEqualDeep(previous, reconciled);
  };

  hasWorkspace(workspaceId: string): boolean {
    return this.entries.has(workspaceId);
  }

  acceptsHttpEpoch(requestEpoch: symbol | undefined): boolean {
    return (requestEpoch ?? this.initialEpoch) === this.epoch;
  }

  captureEpoch(): symbol {
    return this.epoch;
  }

  reconcileDetail(
    data: WorkspaceDetail,
    requestEpoch: symbol | undefined,
    current: WorkspaceDetail | undefined
  ): WorkspaceDetail | undefined {
    // A bootstrap can precede creation of this project owner, but not its retirement.
    if (!this.acceptsHttpEpoch(requestEpoch)) {
      return current;
    }
    const entry = this.entries.get(data.id);
    if (!entry) {
      // Removal reset/cancellation owns membership. HTTP can open archived detail.
      return data;
    }
    return mergeProjectSnapshotIntoWorkspaceDetail(entry, {
      ...data,
      createdAt: current?.createdAt ?? data.createdAt,
      prUpdatedAt: current?.prUpdatedAt ?? data.prUpdatedAt,
    });
  }

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
      this.hasBaseline = true;
    } else if (message.type === 'snapshot_changed') {
      this.entries.set(message.entry.workspaceId, message.entry);
    } else {
      this.entries.delete(message.workspaceId);
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

const detailReconcilers = new WeakMap<QueryClient, Map<string, WorkspaceDetailCacheReconciler>>();

class WorkspaceDetailCacheReconciler {
  private readonly httpResults = new WeakMap<
    object,
    { epochs: Map<string, symbol>; data: WorkspaceDetail }
  >();
  readonly queryKey;
  private active = true;
  private projectId: string | undefined;

  constructor(
    private readonly queryClient: QueryClient,
    private readonly workspaceId: string
  ) {
    this.queryKey = getQueryKey(trpc.workspace.get, { id: workspaceId }, 'query');
  }

  dispose(): void {
    this.active = false;
  }

  identifyProject(): string | undefined {
    const cached = this.queryClient.getQueryData<WorkspaceDetail>(this.queryKey);
    this.projectId ??= cached?.projectId;
    if (!this.projectId) {
      for (const [projectId, owner] of reconcilers.get(this.queryClient) ?? []) {
        if (owner.hasWorkspace(this.workspaceId)) {
          this.projectId = projectId;
          break;
        }
      }
    }
    if (!this.projectId) {
      for (const [, data] of this.queryClient.getQueriesData<ProjectWorkspaceCache>({
        queryKey: getQueryKey(trpc.workspace.listForProject, undefined, 'query'),
      })) {
        const row = data?.workspaces.find((workspace) => workspace.id === this.workspaceId);
        if (row) {
          this.projectId = row.projectId;
          break;
        }
      }
    }
    return this.projectId;
  }

  async fetch(fetchDetail: (signal: AbortSignal) => Promise<WorkspaceDetail>, signal: AbortSignal) {
    if (!this.active) {
      throw new CancelledError({ revert: true });
    }
    this.identifyProject();
    // The detail route knows only its workspace id until HTTP supplies the project.
    const epochs = new Map(
      [...(reconcilers.get(this.queryClient) ?? [])].map(([id, owner]) => [
        id,
        owner.captureEpoch(),
      ])
    );
    const data = await fetchDetail(signal);
    if (this.active) {
      this.projectId = data.projectId;
      this.httpResults.set(data, { epochs, data });
    }
    return data;
  }

  private recoverRejectedQuery(query: Query, rejectedRequest: Promise<unknown> | undefined): void {
    const filter = { queryKey: this.queryKey, exact: true };
    if (!this.active || query !== this.queryClient.getQueryCache().find(filter)) {
      return;
    }
    if (query.promise && query.promise !== rejectedRequest) {
      return;
    }
    if (query.isActive() && query.state.data !== undefined) {
      runInBackground(this.queryClient.invalidateQueries(filter), 'Could not refresh data');
      return;
    }
    const reset = this.queryClient.resetQueries(filter);
    // reset destroys the GC timer; without observers there is no
    // refetch or later observer removal to schedule collection again.
    if (
      query.getObserversCount() === 0 &&
      query.state.fetchStatus === 'idle' &&
      query === this.queryClient.getQueryCache().find(filter)
    ) {
      this.queryClient.removeQueries(filter);
    }
    runInBackground(reset, 'Could not refresh data');
  }

  readonly structuralSharing = (previous: unknown, next: unknown): unknown => {
    if (!this.active) {
      return previous;
    }
    const http = typeof next === 'object' && next !== null ? this.httpResults.get(next) : undefined;
    if (!http) {
      return replaceEqualDeep(previous, next);
    }
    this.httpResults.delete(http.data);
    const owner = getProjectWorkspaceCacheReconciler(this.queryClient, http.data.projectId);
    const requestEpoch = http.epochs.get(http.data.projectId);
    if (!owner.acceptsHttpEpoch(requestEpoch)) {
      const filter = { queryKey: this.queryKey, exact: true };
      const query = this.queryClient.getQueryCache().find(filter);
      if (query?.isActive()) {
        const rejectedRequest = query.promise;
        // Abort this success commit, then retry the same mounted query after its
        // old fetch continuation settles. Unknown direct links learn ownership
        // only from this rejected response, so disconnect could not restart them.
        queueMicrotask(() => this.recoverRejectedQuery(query, rejectedRequest));
        throw new CancelledError({ revert: true });
      }
    }
    const current = this.queryClient.getQueryData<WorkspaceDetail>(this.queryKey);
    return replaceEqualDeep(previous, owner.reconcileDetail(http.data, requestEpoch, current));
  };
}

function getWorkspaceDetailCacheReconciler(queryClient: QueryClient, workspaceId: string) {
  let details = detailReconcilers.get(queryClient);
  if (!details) {
    const owners = new Map<string, WorkspaceDetailCacheReconciler>();
    details = owners;
    detailReconcilers.set(queryClient, owners);
    // QueryCache and its one subscription share the QueryClient lifetime.
    queryClient.getQueryCache().subscribe((event) => {
      const owner = owners.get(event.query.queryHash);
      if (event.type === 'removed') {
        owner?.dispose();
        owners.delete(event.query.queryHash);
      } else if (event.type === 'updated') {
        owner?.identifyProject();
      }
    });
  }
  const queryKey = getQueryKey(trpc.workspace.get, { id: workspaceId }, 'query');
  const queryHash = queryClient.defaultQueryOptions({ queryKey }).queryHash;
  let owner = details.get(queryHash);
  if (!owner) {
    owner = new WorkspaceDetailCacheReconciler(queryClient, workspaceId);
    details.set(queryHash, owner);
  }
  owner.identifyProject();
  return owner;
}

/** Pending requests belong to a project only after independent ownership evidence. */
export function projectWorkspaceDetailQueryFilter(queryClient: QueryClient, projectId: string) {
  return {
    queryKey: getQueryKey(trpc.workspace.get, undefined, 'query'),
    predicate: (query: { queryHash: string; queryKey: readonly unknown[] }) => {
      const owner = detailReconcilers.get(queryClient)?.get(query.queryHash);
      const knownProject =
        owner?.identifyProject() ??
        queryClient.getQueryData<WorkspaceDetail>(query.queryKey)?.projectId;
      return knownProject === projectId;
    },
  };
}

/** Shared cache behavior for ordinary fetches and deliberate creation seeds. */
export function workspaceDetailCacheOptions(queryClient: QueryClient, workspaceId: string) {
  const owner = getWorkspaceDetailCacheReconciler(queryClient, workspaceId);
  return {
    queryKey: owner.queryKey,
    structuralSharing: owner.structuralSharing,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  };
}

export function workspaceDetailQueryOptions(
  queryClient: QueryClient,
  workspaceId: string,
  fetchDetail: (signal: AbortSignal) => Promise<WorkspaceDetail>
) {
  const options = workspaceDetailCacheOptions(queryClient, workspaceId);
  const owner = getWorkspaceDetailCacheReconciler(queryClient, workspaceId);
  return queryOptions({
    ...options,
    queryFn: ({ signal }) => owner.fetch(fetchDetail, signal),
  });
}
