import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { EventAgentEditor } from './event-agent-editor';
import { eventAgentFixture, eventProjectSourcesFixture } from './event-agent.test-support';

function RecoveredBody() {
  const [validated, setValidated] = useState('No validation requested.');
  const [validationInput, setValidationInput] = useState('');
  const agent = {
    ...eventAgentFixture(),
    name: 'Recovered investigation body',
    instructions: 'Inspect the recovered instructions before authoring new events.',
    executionConfig: { version: 1 as const, provider: 'CODEX' as const, model: 'custom-model' },
    definitionRevision: 7,
    managementRevision: 9,
    specification: null,
    configuredTriggers: [],
    retainedTriggers: [],
    retainedNextCursor: null,
  };
  return (
    <main className="mx-auto min-w-0 max-w-3xl space-y-4 p-4">
      <EventAgentEditor
        agent={agent}
        onCancel={() => undefined}
        onSave={() => Promise.resolve()}
        onSources={() => Promise.resolve(eventProjectSourcesFixture(agent.projectId))}
        onValidate={(specification) => {
          setValidationInput(JSON.stringify(specification, null, 2));
          setValidated(
            `Validated complete replacement: ${specification.name}; ${specification.triggers.length} new event(s).`
          );
          return Promise.resolve({
            triggers: [],
            execution: {
              status: 'UNAVAILABLE',
              reasonCode: 'NATIVE_DISCOVERY_UNAVAILABLE',
              explanation: 'Native validation is unavailable in this frontend fixture.',
            },
          });
        }}
      />
      <p role="status">{validated}</p>
      <section aria-label="Validated complete specification input">
        <pre className="whitespace-pre-wrap break-words text-xs">{validationInput}</pre>
      </section>
    </main>
  );
}
const meta = {
  title: 'Agents/EventAgentRecovery',
  component: RecoveredBody,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof RecoveredBody>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InspectAndReplace: Story = {};
