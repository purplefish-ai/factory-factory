import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { agentGetInputSchema, managedTriggerSchema } from '@/shared/agent-management';
import { EventAgentDetail } from './event-agent-detail';
import { EventAgentEditor } from './event-agent-editor';
import { RetainedContinuation as RetainedInspection } from './event-agent-selection';
import { eventAgentFixture, eventProjectSourcesFixture } from './event-agent.test-support';
import type { EventAgent } from './types';

function retainedRecord(id: string) {
  const original = eventAgentFixture().configuredTriggers[0];
  return managedTriggerSchema.parse({
    ...original,
    id,
    isConfigured: false,
    configuration: { ...original?.configuration, description: `Retained ${id}` },
    capability: {
      status: 'UNAVAILABLE',
      reasonCode: 'REMOVED_TRIGGER',
      explanation: 'Removed event retained for inspection.',
    },
  });
}
function retainedPage(agent: EventAgent, cursor?: string) {
  return {
    ...agent,
    retainedTriggers:
      cursor === 'retained-page-2'
        ? [retainedRecord('second'), retainedRecord('shared')]
        : [retainedRecord('shared'), retainedRecord('third')],
    retainedNextCursor: cursor === 'retained-page-2' ? 'retained-page-3' : null,
  };
}
function ContinuationSession({
  surface = 'slack',
  failOnce = false,
}: {
  surface?: 'slack' | 'retained';
  failOnce?: boolean;
}) {
  const [agent] = useState(() => ({
    ...eventAgentFixture(),
    retainedTriggers: [retainedRecord('first')],
    retainedNextCursor: 'retained-page-2',
  }));
  const fail = useRef(failOnce);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const input = agentGetInputSchema.parse(op.input);
              if (input.retainedCursor && fail.current) {
                fail.current = false;
                observer.error(
                  new TRPCClientError('Frontend fixture page unavailable. Retry to continue.')
                );
                return;
              }
              observer.next({ result: { data: retainedPage(agent, input.retainedCursor) } });
              observer.complete();
            }),
      ],
    })
  );
  useEffect(() => () => queryClient.clear(), [queryClient]);
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="min-w-0 max-w-2xl space-y-5 p-4">
          {surface === 'slack' ? (
            <EventAgentEditor
              agent={agent}
              onCancel={() => undefined}
              onSave={() => Promise.resolve()}
              onValidate={() =>
                Promise.resolve({
                  triggers: [],
                  execution: {
                    status: 'UNAVAILABLE',
                    reasonCode: 'NATIVE_DISCOVERY_UNAVAILABLE',
                    explanation: 'Native validation is unavailable in this frontend fixture.',
                  },
                })
              }
              onSources={(input) => {
                if (input.cursor && fail.current) {
                  fail.current = false;
                  return Promise.reject(
                    new Error('Frontend fixture channel page unavailable. Retry to continue.')
                  );
                }
                return Promise.resolve(
                  eventProjectSourcesFixture(agent.projectId, input.connectionId, input.cursor)
                );
              }}
            />
          ) : (
            <EventAgentDetail agent={agent} onEdit={() => undefined}>
              <RetainedInspection agent={agent} />
            </EventAgentDetail>
          )}
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
function ContinuationStory(props: { surface?: 'slack' | 'retained'; failOnce?: boolean }) {
  return <ContinuationSession key={`${props.surface}:${props.failOnce}`} {...props} />;
}
const meta = {
  title: 'Automations/EventAutomationContinuation',
  component: ContinuationStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ContinuationStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SlackPages: Story = { args: { surface: 'slack' } };
export const SlackPageFailure: Story = { args: { surface: 'slack', failOnce: true } };
export const RetainedPages: Story = { args: { surface: 'retained' } };
export const RetainedPageFailure: Story = { args: { surface: 'retained', failOnce: true } };
