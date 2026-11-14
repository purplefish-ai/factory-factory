import type {
  HostProcessBreakdown,
  hostMetricsService,
  ProcessOwner,
} from '@/backend/services/host-metrics';

interface HostLoadBreakdownPorts {
  /** Agent adapters; their providers and tools run beneath them. */
  listAgentProcesses: () => { sessionId: string; pid: number | undefined; isRunning: boolean }[];
  findSessions: (
    ids: string[]
  ) => Promise<{ id: string; workspaceId: string; providerProcessPid: number | null }[]>;
  listTerminals: () => { pid: number; workspaceId: string }[];
  findWorkspaces: (
    ids: string[]
  ) => Promise<{ id: string; name: string; project: { slug: string } }[]>;
  serverPid: number;
  getTopProcesses: typeof hostMetricsService.getTopProcesses;
}

/**
 * The heaviest things on the machine, with agent and terminal process trees
 * named after their workspace and the rest of our own tree after Factory
 * Factory, so "the machine is slow" points at a workspace or another app.
 */
export async function getHostLoadBreakdown(
  ports: HostLoadBreakdownPorts
): Promise<HostProcessBreakdown> {
  // A stopped adapter's pid may already belong to an unrelated process.
  const agents = ports.listAgentProcesses().filter((agent) => agent.isRunning);
  const sessions = await ports.findSessions(agents.map((agent) => agent.sessionId));
  const terminals = ports.listTerminals();

  const workspacePids: { pid: number; workspaceId: string }[] = [
    ...terminals,
    ...sessions.flatMap((session) => {
      const adapterPid = agents.find((agent) => agent.sessionId === session.id)?.pid;
      return [adapterPid, session.providerProcessPid]
        .filter((pid): pid is number => typeof pid === 'number')
        .map((pid) => ({ pid, workspaceId: session.workspaceId }));
    }),
  ];
  const workspaces = await ports.findWorkspaces([
    ...new Set(workspacePids.map(({ workspaceId }) => workspaceId)),
  ]);
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

  const owners = new Map<number, ProcessOwner>([
    [
      ports.serverPid,
      { key: 'factory-factory', label: 'Factory Factory', kind: 'factory', workspace: null },
    ],
  ]);
  for (const { pid, workspaceId } of workspacePids) {
    const workspace = workspaceById.get(workspaceId);
    owners.set(pid, {
      key: `workspace:${workspaceId}`,
      label: workspace?.name ?? 'Unknown workspace',
      kind: 'workspace',
      workspace: workspace ? { id: workspace.id, projectSlug: workspace.project.slug } : null,
    });
  }
  return ports.getTopProcesses(owners);
}
