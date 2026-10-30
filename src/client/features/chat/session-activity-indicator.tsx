import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { SUBAGENT_ICONS, SubagentIcon } from '@/client/components/subagent-icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
  const backgroundLabel =
    backgroundTasks.length === 1
      ? `Background ${backgroundKind} running`
      : `${backgroundTasks.length} background ${backgroundKind === 'process' ? 'processes' : 'tasks'} running`;
  const runningSubagents = work?.runningSubagents ?? 0;
  const subagentLabel = `${runningSubagents} ${runningSubagents === 1 ? 'sub-agent' : 'sub-agents'} running`;
  return (
    <div className="space-y-3 py-4">
      {agentWorking && (
        <div role="status" aria-label="Session activity">
          <LoadingIndicator latestReasoning={latestThinking} />
        </div>
      )}
      {backgroundTasks.length > 0 && (
        <Collapsible defaultOpen={false} className="text-sm text-muted-foreground">
          <span role="status" aria-label="Background activity" className="sr-only">
            {backgroundLabel}
          </span>
          <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <CaretRightIcon className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
            <TerminalIcon className="h-4 w-4 shrink-0" />
            <span>{backgroundLabel}</span>
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
      {!!runningSubagents && (
        <div>
          <span role="status" aria-label="Sub-agent activity" className="sr-only">
            {subagentLabel}
          </span>
          <button
            type="button"
            onClick={onOpenAgents}
            disabled={!onOpenAgents}
            title="Open Sessions panel"
            className="group flex max-w-full items-center gap-2 rounded-sm text-left text-sm text-muted-foreground transition-colors enabled:cursor-pointer enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5">
              {SUBAGENT_ICONS.slice(0, Math.min(3, runningSubagents)).map(({ color }, index) => (
                <SubagentIcon key={color} index={index} />
              ))}
            </span>
            <span>{subagentLabel}</span>
            <CaretRightIcon
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 opacity-50 transition-opacity group-enabled:group-hover:opacity-100"
            />
          </button>
        </div>
      )}
      {!!work?.activeGoals && (
        <p className="text-sm text-muted-foreground" role="status">
          {work.activeGoals} {work.activeGoals === 1 ? 'goal' : 'goals'} active
        </p>
      )}
      {!agentWorking && backgroundTasks.length === 0 && !runningSubagents && !work?.activeGoals && (
        <p className="text-sm text-muted-foreground" role="status">
          Background activity running
        </p>
      )}
    </div>
  );
}
