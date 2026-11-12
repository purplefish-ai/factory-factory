import { type ReactNode, useState } from 'react';
import { TabButton, TabList } from '@/components/ui/tab-button';
import { EventEvaluationHistory } from './event-evaluation-history';
import { EventRunHistory } from './event-run-history';
import type { EventAgent, EventRun } from './types';

/** Trigger descriptions by ID, including removed triggers still kept for inspection. */
function triggerLabels(agent: EventAgent) {
  const labels: Record<string, string> = {};
  for (const trigger of [...agent.retainedTriggers, ...agent.configuredTriggers]) {
    const description = trigger.configuration?.description;
    if (description) {
      labels[trigger.id] = description;
    }
  }
  return labels;
}

/** The Runs and Events views of a saved event-triggered automation. */
export function EventAgentHistory({
  agent,
  projectSlug,
  renderRunActions,
}: {
  agent: EventAgent;
  projectSlug: string;
  renderRunActions?: (run: EventRun) => ReactNode;
}) {
  const [view, setView] = useState<'runs' | 'events'>('runs');
  return (
    <div className="min-w-0 space-y-4">
      <TabList aria-label="Automation history" className="gap-1">
        <TabButton label="Runs" isActive={view === 'runs'} onSelect={() => setView('runs')} />
        <TabButton label="Events" isActive={view === 'events'} onSelect={() => setView('events')} />
      </TabList>
      {view === 'runs' ? (
        <EventRunHistory
          projectId={agent.projectId}
          agentId={agent.id}
          projectSlug={projectSlug}
          renderRunActions={renderRunActions}
        />
      ) : (
        <EventEvaluationHistory
          projectId={agent.projectId}
          agentId={agent.id}
          triggerLabels={triggerLabels(agent)}
        />
      )}
    </div>
  );
}
