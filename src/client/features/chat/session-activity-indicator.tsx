import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import type { SessionWorkState } from '@/shared/session-runtime';
import { LoadingIndicator } from './agent-activity';

export function SessionActivityIndicator({
  work,
  latestThinking,
  onOpenAgents,
}: {
  work?: SessionWorkState;
  latestThinking?: string | null;
  onOpenAgents?: () => void;
}) {
  const tasks = work?.backgroundTasks ?? [];
  const backgroundTasks = tasks.filter((task) => task.kind !== 'turn');
  const agentWorking = work?.promptInFlight !== false || tasks.some((task) => task.kind === 'turn');
  const backgroundKind = backgroundTasks.every((task) => task.kind === 'shell')
    ? 'process'
    : 'task';
  return (
    <div className="space-y-3 py-4" role="status" aria-label="Session activity">
      {agentWorking && <LoadingIndicator latestReasoning={latestThinking} />}
      {backgroundTasks.length > 0 && (
        <div className="text-sm text-muted-foreground space-y-2">
          <div className="flex items-center gap-2">
            <TerminalIcon className="h-4 w-4 shrink-0" />
            <span>
              {backgroundTasks.length === 1
                ? `Background ${backgroundKind} running`
                : `${backgroundTasks.length} background ${backgroundKind === 'process' ? 'processes' : 'tasks'} running`}
            </span>
          </div>
          <ul className="space-y-1 max-h-40 overflow-auto">
            {backgroundTasks.map((task) => (
              <li key={task.id} className="font-mono text-xs whitespace-pre-wrap break-all">
                {task.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!work?.runningSubagents && (
        <button
          type="button"
          onClick={onOpenAgents}
          disabled={!onOpenAgents}
          title="Open Agents panel"
          className="block text-sm text-muted-foreground enabled:cursor-pointer enabled:hover:text-foreground enabled:hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          {work.runningSubagents} {work.runningSubagents === 1 ? 'sub-agent' : 'sub-agents'} running
        </button>
      )}
      {!!work?.activeGoals && (
        <p className="text-sm text-muted-foreground">
          {work.activeGoals} {work.activeGoals === 1 ? 'goal' : 'goals'} active
        </p>
      )}
      {!agentWorking &&
        backgroundTasks.length === 0 &&
        !work?.runningSubagents &&
        !work?.activeGoals && (
          <p className="text-sm text-muted-foreground">Background activity running</p>
        )}
    </div>
  );
}
