import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import {
  ackMailInputSchema,
  listMailInputSchema,
  readMailInputSchema,
} from '@/shared/workspace-mail';
import type { WorkspaceMailSummary } from '@/shared/workspace-mail';
import { WorkspaceInboxPanel } from './workspace-inbox-panel';

type Scenario =
  | 'messages'
  | 'long-report'
  | 'empty'
  | 'loading'
  | 'list-error'
  | 'read-error'
  | 'ack-error'
  | 'pagination'
  | 'ambiguous'
  | 'retry-error';
const receivedAt = new Date('2026-11-02T14:00:00Z');
const messages: WorkspaceMailSummary[] = [
  {
    id: 'blocker',
    revision: 4,
    subject: 'Authentication needs a decision',
    preview: 'Should we use the existing identity provider for the admin portal?',
    kind: 'QUESTION',
    sourceWorkspaceId: 'auth',
    sourceWorkspaceName: 'Authentication',
    sourceProjectName: 'Factory Factory',
    createdAt: receivedAt,
    readAt: null,
    acknowledgedAt: null,
    supersededAt: null,
    taskKey: null,
    taskRevision: null,
  },
  {
    id: 'report',
    revision: 3,
    subject: 'Review ready',
    preview: 'The workspace review is complete. Two small issues need attention before merging.',
    kind: 'COMPLETION',
    sourceWorkspaceId: 'review',
    sourceWorkspaceName: 'Code review',
    sourceProjectName: 'Factory Factory',
    createdAt: receivedAt,
    readAt: null,
    acknowledgedAt: null,
    supersededAt: null,
    taskKey: null,
    taskRevision: null,
  },
  {
    id: 'progress',
    revision: 2,
    subject: 'Integration checks running',
    preview: 'The backend checks passed. The browser checks are still running.',
    kind: 'PROGRESS',
    sourceWorkspaceId: 'checks',
    sourceWorkspaceName: 'Integration checks',
    sourceProjectName: 'Factory Factory',
    createdAt: receivedAt,
    readAt: receivedAt,
    acknowledgedAt: null,
    supersededAt: null,
    taskKey: 'checks',
    taskRevision: 2,
  },
];
function reportBody(scenario: Scenario, offset: number) {
  if (offset > 0) {
    return '\n\nThe remaining checks passed. The review is complete.';
  }
  if (scenario === 'long-report') {
    return `The first section covers workspace permissions and background tasks.\n\n${'All workspace permission checks passed. '.repeat(70)}`;
  }
  return 'Please review the authentication choice before implementation continues.\n\nThe existing identity provider supports the required roles. Keeping one sign-in flow will make account administration easier.';
}
function createResponses(scenario: Scenario) {
  const readIds = new Set<string>();
  const acknowledgedIds = new Set<string>();
  let wakeAmbiguous = scenario === 'ambiguous' || scenario === 'retry-error';
  function summaries() {
    return messages.map((mail) => ({
      ...mail,
      readAt: readIds.has(mail.id) ? receivedAt : mail.readAt,
      acknowledgedAt: acknowledgedIds.has(mail.id) ? receivedAt : null,
    }));
  }
  const handlers: Record<string, (input: unknown) => unknown> = {
    'workspace.listMail': (input) => {
      if (scenario !== 'pagination') {
        return {
          items: scenario === 'empty' ? [] : summaries(),
          nextCursor: null,
          revision: 4,
          wakeAmbiguous,
        };
      }
      const { cursor } = listMailInputSchema.parse(input);
      return {
        items: cursor ? summaries().slice(2) : summaries().slice(0, 2),
        nextCursor: cursor ? null : 3,
        revision: 4,
      };
    },
    'workspace.readMail': (input) => {
      const { ids, offset } = readMailInputSchema.parse(input);
      for (const id of ids) {
        readIds.add(id);
      }
      const body = reportBody(scenario, offset);
      const nextOffset = scenario === 'long-report' && offset === 0 ? 2800 : null;
      return {
        items: summaries()
          .filter((mail) => ids.includes(mail.id))
          .map((mail) => ({ ...mail, body, offset, nextOffset })),
        revision: 4,
      };
    },
    'workspace.retryMailWake': () => {
      wakeAmbiguous = false;
      return { retried: true };
    },
    'workspace.ackMail': (input) => {
      const { ids } = ackMailInputSchema.parse(input);
      for (const id of ids) {
        acknowledgedIds.add(id);
      }
      return { acknowledged: ids.length, revision: 4 };
    },
  };
  return (path: string, input: unknown) => {
    const failedPath = {
      'list-error': 'workspace.listMail',
      'read-error': 'workspace.readMail',
      'ack-error': 'workspace.ackMail',
      'retry-error': 'workspace.retryMailWake',
    };
    if (scenario in failedPath && Reflect.get(failedPath, scenario) === path) {
      throw new Error('Connection interrupted. Please try again.');
    }
    return handlers[path]?.(input);
  };
}
function storyClientError(error: unknown) {
  return new TRPCClientError(error instanceof Error ? error.message : 'Could not load messages');
}
function Fixture({ scenario }: { scenario: Scenario }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() => {
    const respond = createResponses(scenario);
    return trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (scenario === 'loading') {
                return;
              }
              try {
                observer.next({ result: { data: respond(op.path, op.input) } });
                observer.complete();
              } catch (error) {
                observer.error(storyClientError(error));
              }
            }),
      ],
    });
  });
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkspaceInboxPanel workspaceId="inbox-story" />
      </QueryClientProvider>
    </trpc.Provider>
  );
}
function InboxStory({
  scenario = 'messages',
  width = 440,
}: {
  scenario?: Scenario;
  width?: number;
}) {
  return (
    <div className="h-[540px] border bg-background" style={{ width }}>
      <Fixture key={scenario} scenario={scenario} />
    </div>
  );
}
const meta = {
  title: 'Workspace/Inbox',
  component: InboxStory,
  parameters: { layout: 'padded' },
  args: { scenario: 'messages', width: 440 },
} satisfies Meta<typeof InboxStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const UnreadMessages: Story = {};
export const NarrowInbox: Story = { args: { width: 320 } };
export const ReadAndAcknowledge: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: /Authentication needs a decision/ })
    );
    await expect(await canvas.findByText(/The existing identity provider supports/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /^Acknowledge$/ }));
    await expect(await canvas.findByRole('button', { name: /^Acknowledged$/ })).toBeDisabled();
  },
};
export const LongReport: Story = {
  args: { scenario: 'long-report' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /Review ready/ }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Read more' }));
    await expect(await canvas.findByText(/The remaining checks passed/)).toBeVisible();
  },
};
export const Empty: Story = { args: { scenario: 'empty' } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const ListFailure: Story = { args: { scenario: 'list-error' } };
export const ReadFailure: Story = {
  args: { scenario: 'read-error' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /Review ready/ }));
    await expect(await canvas.findByText(/Could not read message/)).toBeVisible();
  },
};
export const AcknowledgementFailure: Story = {
  args: { scenario: 'ack-error' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /Review ready/ }));
    const acknowledge = await canvas.findByRole('button', { name: /^Acknowledge$/ });
    await expect(acknowledge).toBeEnabled();
    await userEvent.click(acknowledge);
    await expect(await canvas.findByText(/Could not acknowledge message/)).toBeVisible();
  },
};

export const Pagination: Story = {
  args: { scenario: 'pagination' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Load older messages' }));
    await expect(
      await canvas.findByRole('button', { name: /Integration checks running/ })
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Load older messages' })
    ).not.toBeInTheDocument();
  },
};

export const AmbiguousNotification: Story = { args: { scenario: 'ambiguous' } };
export const RetryNotification: Story = {
  args: { scenario: 'ambiguous' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'Delivery could not be confirmed. Retrying may notify the agent again.'
      )
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry mail notification' }));
    await expect(
      canvas.queryByRole('button', { name: 'Retry mail notification' })
    ).not.toBeInTheDocument();
  },
};
export const RetryNotificationFailure: Story = {
  args: { scenario: 'retry-error' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Retry mail notification' }));
    await expect(await canvas.findByText(/Could not retry mail notification/)).toBeVisible();
  },
};
