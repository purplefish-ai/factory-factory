import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { SessionWorkState } from '@/shared/session-runtime';
import { LoadingIndicator } from './agent-activity';

export function SessionActivityIndicator({
  work,
  latestThinking,
}: {
  work?: SessionWorkState;
  latestThinking?: string | null;
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
        <Collapsible defaultOpen={false} className="text-sm text-muted-foreground">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <CaretRightIcon className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
            <TerminalIcon className="h-4 w-4 shrink-0" />
            <span>
              {backgroundTasks.length === 1
                ? `Background ${backgroundKind} running`
                : `${backgroundTasks.length} background ${backgroundKind === 'process' ? 'processes' : 'tasks'} running`}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 space-y-1 max-h-40 overflow-auto">
              {backgroundTasks.map((task) => (
                <li key={task.id} className="font-mono text-xs whitespace-pre-wrap break-all">
                  {task.name}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      {!!work?.runningSubagents && (
        <p className="text-sm text-muted-foreground">
          {work.runningSubagents} {work.runningSubagents === 1 ? 'sub-agent' : 'sub-agents'} running
        </p>
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
