import type { inferRouterOutputs } from '@trpc/server';
import { Link } from 'react-router';
import type { AppRouter } from '@/client/lib/trpc';
import { formatBytes } from '@/lib/formatters';

/** The heaviest workspaces, apps and processes on the machine, from one `ps` reading. */
export type HostLoadBreakdown = inferRouterOutputs<AppRouter>['admin']['getHostLoadBreakdown'];
type ProcessGroup = HostLoadBreakdown['byCpu'][number];

function GroupName({ group }: { group: ProcessGroup }) {
  const processes = group.processCount === 1 ? '1 process' : `${group.processCount} processes`;
  if (group.workspace) {
    return (
      <Link
        to={`/projects/${group.workspace.projectSlug}/workspaces/${group.workspace.id}`}
        title={`Workspace · ${processes}`}
        className="min-w-0 truncate underline-offset-2 hover:underline"
      >
        {group.label}
      </Link>
    );
  }
  return (
    <span title={processes} className="min-w-0 truncate">
      {group.label}
    </span>
  );
}

function GroupList({
  title,
  groups,
  value,
}: {
  title: string;
  groups: readonly ProcessGroup[];
  value: (group: ProcessGroup) => string;
}) {
  return (
    <section className="space-y-1">
      <h3 className="text-muted-foreground">{title}</h3>
      <ul className="space-y-0.5">
        {groups.map((group) => (
          <li key={group.key} className="flex items-baseline gap-3">
            <GroupName group={group} />
            {group.kind === 'workspace' ? (
              <span className="shrink-0 text-muted-foreground">workspace</span>
            ) : null}
            <span className="ml-auto shrink-0 tabular-nums">{value(group)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Answers "why is it slow?": what is using the CPU and memory right now.
 * CPU is a share of the whole machine, so it adds up toward the header figure.
 */
export function HostLoadBreakdownView({ breakdown }: { breakdown: HostLoadBreakdown | undefined }) {
  if (!breakdown) {
    return <p className="text-muted-foreground">Reading processes…</p>;
  }
  return (
    <>
      <GroupList
        title="Using the most CPU"
        groups={breakdown.byCpu}
        value={(group) => `${Math.round(group.cpuPercent)}%`}
      />
      <GroupList
        title="Using the most memory"
        groups={breakdown.byMemory}
        value={(group) => formatBytes(group.memoryBytes, { precision: 1 })}
      />
    </>
  );
}
