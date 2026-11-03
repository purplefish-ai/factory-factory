// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { MessageItem } from './agent-activity';

const signal =
  'You have workspace mail (revision 228). Use list_mail to inspect summaries, read_mail for selected bodies, and ack_mail with the observed revision after inspection. Mail acknowledgement is separate from task completion.\n\n<!-- workspace-mail-wake-recipient:228 -->';
function userMessage(id: string, text = signal): ChatMessage {
  return { id, text, source: 'user', timestamp: '2026-11-03T12:00:00Z', order: 0 };
}

it.each(['workspace-mail-wake-recipient:228', 'provider-history-id'])(
  'renders mail quietly before and after provider history restoration (%s)',
  (id) => {
    const html = renderToStaticMarkup(
      <MessageItem
        message={userMessage(id)}
        isQueued
        onRemove={() => undefined}
        onSteer={() => undefined}
        userMessageUuid="uuid"
        onRewindToMessage={() => undefined}
      />
    );
    expect(html).toContain('Workspace mail');
    expect(html).toContain('<summary');
    expect(html).not.toContain('list_mail');
    expect(html).not.toContain('workspace-mail-wake-');
    expect(html).not.toContain('Steer queued message');
    expect(html).not.toContain('Cancel queued message');
    expect(html).not.toContain('Rewind files');
    expect(html).not.toContain('Workspace inbox');
  }
);

it('preserves user instructions combined with a mail receipt', () => {
  const html = renderToStaticMarkup(
    <MessageItem
      message={userMessage('provider-history-id', `Please fix the tests.\n\n${signal}`)}
    />
  );
  expect(html).toContain('Please fix the tests.');
  expect(html).not.toContain('<summary');
});

it.each(['attachments', 'mismatched revision', 'assistant quote'])(
  'keeps ordinary content visible when it has %s',
  (kind) => {
    const message = userMessage(
      'provider-history-id',
      kind === 'mismatched revision' ? signal.replace('recipient:228', 'recipient:229') : signal
    );
    if (kind === 'attachments') {
      message.attachments = [
        {
          id: 'file',
          name: 'note.txt',
          type: 'text/plain',
          size: 4,
          data: 'data:text/plain;base64,dGVzdA==',
        },
      ];
    }
    if (kind === 'assistant quote') {
      message.source = 'agent';
      message.message = { type: 'assistant', message: { role: 'assistant', content: signal } };
    }
    const html = renderToStaticMarkup(<MessageItem message={message} />);
    expect(html).not.toContain('<summary');
  }
);

it.each(['child_workspace_update', 'parent_workspace_update'] as const)(
  'collapses structured legacy %s events',
  (type) => {
    const html = renderToStaticMarkup(
      <MessageItem
        message={{
          id: 'legacy',
          source: 'agent',
          order: 0,
          timestamp: '2026-11-03T12:00:00Z',
          message: {
            type,
            childWorkspaceName: 'Review',
            parentWorkspaceName: 'Coordinator',
            text: 'Ready for review',
          },
        }}
      />
    );
    expect(html).toContain('<summary');
    expect(html).toContain('Ready for review');
    expect(html).toContain(type === 'child_workspace_update' ? 'Review' : 'Coordinator');
  }
);

it('collapses restored parent and child notification bodies without exposing receipt markers', () => {
  const html = renderToStaticMarkup(
    <MessageItem
      message={userMessage(
        'provider-history-id',
        '[Message from child workspace "Review"]: Ready to merge\n\n<!-- factory-factory-workspace-notification:notice-1 -->'
      )}
    />
  );
  expect(html).toContain('<summary');
  expect(html).toContain('Review');
  expect(html).toContain('Ready to merge');
  expect(html).not.toContain('factory-factory-workspace-notification');
});
