import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { SubagentIcon } from '@/client/components/subagent-icon';
import {
  SessionTargetStopButton,
  useReconcileSessionTargetStops,
} from '@/client/features/session-controls';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { SessionWorkState } from '@/shared/session-runtime';
import { LoadingIndicator } from './agent-activity';

function getActivityState(work?: SessionWorkState) {
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
  const activeGoals = work?.activeGoals ?? 0;
  const hasBackgroundActivity =
    backgroundTasks.length > 0 || runningSubagents > 0 || activeGoals > 0;
  return {
    backgroundTasks,
    agentWorking,
    backgroundLabel,
    runningSubagents,
    subagentLabel,
    activeGoals,
    hasBackgroundActivity,
  };
}

export function SessionActivityIndicator({
  work,
  controlSessionId,
  latestThinking,
  onOpenAgents,
  showThinking = true,
  runningSubagentIconIndices = [],
}: {
  showThinking?: boolean;
  runningSubagentIconIndices?: readonly number[];
  work?: SessionWorkState;
  controlSessionId?: string;
  latestThinking?: string | null;
  onOpenAgents?: () => void;
}) {
  const {
    backgroundTasks,
    agentWorking,
    backgroundLabel,
    runningSubagents,
    subagentLabel,
    activeGoals,
    hasBackgroundActivity,
  } = getActivityState(work);
  useReconcileSessionTargetStops(controlSessionId, 'task', work ? backgroundTasks : undefined);
  if (!(showThinking || hasBackgroundActivity)) {
    return null;
  }
  return (
    <div className="space-y-3 py-4">
      {showThinking && agentWorking && (
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
                <li
                  key={task.id}
                  className="flex items-center gap-2 font-mono text-xs whitespace-pre-wrap break-all"
                >
                  <span className="min-w-0 flex-1">{task.name}</span>
                  {controlSessionId &&
                    task.stopControl &&
                    task.stopControl.runtimeId === work?.controlRuntimeId && (
                      <SessionTargetStopButton
                        key={task.stopControl.controlId}
                        sessionId={controlSessionId}
                        itemLabel={task.name}
                        target={{
                          kind: 'task',
                          id: task.id,
                          controlId: task.stopControl.controlId,
                        }}
                      />
                    )}
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
              {runningSubagentIconIndices.slice(0, Math.min(3, runningSubagents)).map((index) => (
                <SubagentIcon key={index} index={index} />
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
      {activeGoals > 0 && (
        <p className="text-sm text-muted-foreground" role="status">
          {activeGoals} {activeGoals === 1 ? 'goal' : 'goals'} active
        </p>
      )}
      {!(agentWorking || hasBackgroundActivity) && (
        <p className="text-sm text-muted-foreground" role="status">
          Background activity running
        </p>
      )}
    </div>
  );
}
