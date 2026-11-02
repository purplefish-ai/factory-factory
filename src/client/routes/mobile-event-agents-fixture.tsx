import { EventAgentDetail } from '@/client/features/agents/event-agent-detail';
import { EventAgentEditor } from '@/client/features/agents/event-agent-editor';
import { eventAgentFixture } from '@/client/features/agents/event-agent.test-support';
import type { EventAgent } from '@/client/features/agents/types';

export function mobileEventFixtures(projectId: string): EventAgent[] {
  const event = { ...eventAgentFixture(), projectId };
  return [
    event,
    {
      ...event,
      id: 'replacement-agent',
      name: 'Repair saved configuration',
      configurationMembership: 'UNKNOWN',
      specification: null,
      executionConfig: null,
      configuredTriggers: [],
      retainedTriggers: event.configuredTriggers.map((trigger) => ({
        ...trigger,
        isConfigured: null,
        configuration: null,
        capability: {
          status: 'UNAVAILABLE',
          reasonCode: 'INVALID_STORED_DATA',
          explanation: 'Stored configuration is unavailable.',
        },
      })),
    },
  ];
}
/** Explicit fixture callbacks only; no source or native owner can be acquired. */
export function MobileEventAgentContent({
  agent,
  editing,
  onEdit,
  onCancel,
  onSaved,
}: {
  agent: EventAgent;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: (agent: EventAgent) => void;
}) {
  return editing ? (
    <EventAgentEditor
      key={`${agent.projectId}:event:${agent.id}`}
      agent={agent}
      onCancel={onCancel}
      onSave={async (specification) =>
        onSaved({
          ...agent,
          name: specification.name,
          instructions: specification.instructions,
          executionConfig: specification.executionConfig,
          specification,
          managementRevision: agent.managementRevision + 1,
        })
      }
      onValidate={async () => ({
        triggers: [],
        execution: {
          status: 'UNAVAILABLE',
          reasonCode: 'NATIVE_DISCOVERY_UNAVAILABLE',
          explanation: 'Native discovery is unavailable in this frontend fixture.',
        },
      })}
      onSources={async () => ({
        project: { id: agent.projectId, name: 'Factory Factory' },
        slack: { connections: [] },
        github: { error: 'Source discovery is unavailable in this frontend fixture.' },
      })}
    />
  ) : (
    <EventAgentDetail agent={agent} onEdit={onEdit} />
  );
}
