import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ChatTranscript } from '@/client/features/chat';
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
  | 'ack-already'
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
function reportBody(scenario: Scenario) {
  if (scenario === 'long-report') {
    return `The first section covers workspace permissions and background tasks.\n\n${'All workspace permission checks passed. '.repeat(230)}\n\nThe remaining checks passed. The review is complete.`;
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
      const { ids, offset, maxChars } = readMailInputSchema.parse(input);
      const fullBody = reportBody(scenario);
      let remaining = maxChars;
      return {
        items: summaries()
          .filter((mail) => ids.includes(mail.id))
          .map((mail) => {
            const start = Math.min(offset, fullBody.length);
            const body = fullBody.slice(start, start + remaining);
            remaining -= body.length;
            if (body.length > 0) {
              readIds.add(mail.id);
            }
            const end = start + body.length;
            return {
              ...mail,
              readAt: readIds.has(mail.id) ? receivedAt : mail.readAt,
              body,
              offset: start,
              nextOffset: end < fullBody.length ? end : null,
            };
          }),
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
      return { acknowledged: scenario === 'ack-already' ? 0 : ids.length, revision: 4 };
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
    const handler = handlers[path];
    if (!handler) {
      throw new Error(`Missing inbox story handler for ${path}`);
    }
    return handler(input);
  };
}
function storyClientError(error: unknown) {
  return new TRPCClientError(error instanceof Error ? error.message : 'Could not load messages');
}
function Fixture({
  scenario,
  notification = false,
  queued = false,
}: {
  scenario: Scenario;
  notification?: boolean;
  queued?: boolean;
}) {
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
        {notification ? (
          <ChatTranscript
            scroll={{
              identity: 'inbox-notification-story',
              active: true,
              ready: true,
              initialIntent: 'following',
              initialPosition: null,
            }}
            messages={[
              {
                id: 'workspace-mail-wake-inbox-story:4',
                source: 'user',
                timestamp: '2026-11-03T12:00:00Z',
                order: 0,
                text: 'You have workspace mail (revision 4). Use list_mail to inspect summaries, read_mail for selected bodies, and ack_mail with the observed revision after inspection. Mail acknowledgement is separate from task completion.\n\n<!-- workspace-mail-wake-inbox-story:4 -->',
              },
            ]}
            queuedMessageIds={new Set(queued ? ['workspace-mail-wake-inbox-story:4'] : [])}
            running={false}
            startingSession={false}
            loadingSession={false}
          />
        ) : (
          <WorkspaceInboxPanel workspaceId="inbox-story" />
        )}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
function InboxStory({
  scenario = 'messages',
  width = 440,
  notification = false,
  queued = false,
}: {
  scenario?: Scenario;
  width?: number;
  notification?: boolean;
  queued?: boolean;
}) {
  return (
    <div className="h-[540px] border bg-background" style={{ width }}>
      <Fixture key={scenario} scenario={scenario} notification={notification} queued={queued} />
    </div>
  );
}
const meta = {
  title: 'Workspace/WorkspaceInboxPanel',
  component: InboxStory,
  parameters: { layout: 'padded' },
  args: { scenario: 'messages', width: 440 },
} satisfies Meta<typeof InboxStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const UnreadMessages: Story = {};
export const NarrowInbox: Story = { args: { width: 320 } };
export const MailNotification: Story = { args: { notification: true, width: 720 } };
export const QueuedMailNotification: Story = {
  args: { notification: true, queued: true, width: 720 },
};
export const ReadFromNotification: Story = {
  args: { notification: true, width: 720 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('region', { name: 'Workspace inbox' })).toBeNull();
    await userEvent.click(canvas.getByText('Workspace mail'));
    await userEvent.click(
      await canvas.findByRole('button', { name: /Authentication needs a decision/ })
    );
    await expect(await canvas.findByText(/The existing identity provider supports/)).toBeVisible();
  },
};
export const NarrowMailNotification: Story = { args: { notification: true, width: 320 } };
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
export const AlreadyAcknowledgedElsewhere: Story = {
  args: { scenario: 'ack-already' },
  play: ReadAndAcknowledge.play,
};
export const LongReport: Story = {
  args: { scenario: 'long-report' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /Review ready/ }));
    await expect(canvas.getByRole('button', { name: /^Acknowledge$/ })).toBeDisabled();
    await userEvent.click(await canvas.findByRole('button', { name: 'Read more' }));
    await expect(await canvas.findByText(/The remaining checks passed/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: /^Acknowledge$/ })).toBeEnabled();
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
    await expect(await canvas.findByText(/Couldn't read message/)).toBeVisible();
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
    await expect(await canvas.findByText(/Couldn't acknowledge message/)).toBeVisible();
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
    const banner = await canvas.findByText(
      'Delivery could not be confirmed. Retrying may notify the agent again.'
    );
    await expect(banner).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry mail notification' }));
    await waitFor(() => expect(banner).not.toBeInTheDocument());
  },
};
export const RetryNotificationFailure: Story = {
  args: { scenario: 'retry-error' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Retry mail notification' }));
    await expect(await canvas.findByText(/Couldn't retry mail notification/)).toBeVisible();
  },
};
