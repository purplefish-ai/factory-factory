import { useEffect, useState } from 'react';
import { EventAgentDetail } from './event-agent-detail';
import { EventAgentEditor } from './event-agent-editor';
import { EventDraftPreview } from './event-agent-preview';
import { eventAgentFixture } from './event-agent.test-support';
import type { EventAgent } from './types';

export type EventStoryState =
  | 'event'
  | 'event-edit'
  | 'event-unknown'
  | 'event-replacement'
  | 'event-null'
  | 'event-health-error'
  | 'event-health-catching-up'
  | 'event-preview-unsupported'
  | 'event-preview-unavailable'
  | 'event-conflict';
export function eventStoryAgent(state: EventStoryState): EventAgent {
  const agent = eventAgentFixture();
  if (state === 'event-unknown' || state === 'event-replacement') {
    return {
      ...agent,
      configurationMembership: 'UNKNOWN',
      specification: null,
      configuredTriggers: [],
      retainedTriggers: agent.configuredTriggers.map((trigger) => ({
        ...trigger,
        isConfigured: null,
        capability: {
          status: 'UNAVAILABLE',
          reasonCode: 'UNKNOWN_MEMBERSHIP',
          explanation: 'Membership is unknown; a complete replacement is required.',
        },
      })),
    };
  }
  if (state === 'event-null') {
    return {
      ...agent,
      specification: null,
      executionConfig: null,
      configuredTriggers: agent.configuredTriggers.map((trigger) => ({
        ...trigger,
        configuration: null,
        capability: {
          status: 'UNAVAILABLE',
          reasonCode: 'INVALID_STORED_DATA',
          explanation: 'Stored configuration is unavailable.',
        },
      })),
    };
  }
  if (state === 'event-health-error' || state === 'event-health-catching-up') {
    return {
      ...agent,
      configuredTriggers: agent.configuredTriggers.map((trigger) => ({
        ...trigger,
        sourceHealth: {
          state: state === 'event-health-error' ? 'ERROR' : 'CATCHING_UP',
          reasonCode: 'SOURCE_WAIT',
          updatedAt: agent.updatedAt,
        },
      })),
    };
  }
  return agent;
}
export function EventDashboardStory({ state }: { state: EventStoryState }) {
  const [agent, setAgent] = useState(() => eventStoryAgent(state));
  const [editing, setEditing] = useState(
    state === 'event-edit' ||
      state === 'event-replacement' ||
      state.startsWith('event-preview') ||
      state === 'event-conflict'
  );
  useEffect(() => {
    if (state === 'event-conflict') {
      setAgent((current) => ({ ...current, managementRevision: current.managementRevision + 1 }));
    }
  }, [state]);
  return (
    <>
      {editing ? (
        <EventAgentEditor
          agent={agent}
          initialReplacement={state === 'event-replacement'}
          onCancel={() => setEditing(false)}
          onSave={(specification) => {
            if (state === 'event-conflict') {
              return Promise.reject(
                new Error(
                  'The saved definition changed. Your draft and original token are preserved.'
                )
              );
            }
            setAgent({
              ...agent,
              specification,
              name: specification.name,
              instructions: specification.instructions,
              executionConfig: specification.executionConfig,
            });
            setEditing(false);
            return Promise.resolve();
          }}
          onValidate={async () => ({
            triggers: [],
            execution: {
              status: 'UNAVAILABLE',
              reasonCode: 'NATIVE_DISCOVERY_UNAVAILABLE',
              explanation: 'Native discovery is temporarily unavailable. Retry validation.',
            },
          })}
          onSources={async () => ({
            project: { id: agent.projectId, name: 'Project' },
            slack: { connections: [] },
            github: { error: 'GitHub discovery unavailable.' },
          })}
        />
      ) : (
        <EventAgentDetail agent={agent} onEdit={() => setEditing(true)} saved />
      )}
      {(state === 'event-preview-unsupported' || state === 'event-preview-unavailable') && (
        <EventDraftPreview
          preview={{
            triggers: [],
            execution:
              state === 'event-preview-unsupported'
                ? {
                    status: 'UNSUPPORTED',
                    reasonCode: 'UNSUPPORTED_REASONING_EFFORT',
                    explanation: 'The explicitly requested effort is unsupported by this model.',
                  }
                : {
                    status: 'UNAVAILABLE',
                    reasonCode: 'NATIVE_DISCOVERY_UNAVAILABLE',
                    explanation: 'Native discovery is temporarily unavailable. Retry validation.',
                  },
          }}
        />
      )}
    </>
  );
}
