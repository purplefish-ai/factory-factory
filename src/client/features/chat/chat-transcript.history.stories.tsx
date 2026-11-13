import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { createUserMessage } from '@/lib/claude.fixture';
import { ChatTranscript } from './chat-transcript';
import { chatTranscriptMeta, startupMessage } from './chat-transcript.story-fixtures';

const meta: Meta<typeof ChatTranscript> = {
  ...chatTranscriptMeta,
  title: 'Chat/Transcript/ChatTranscript',
};

export default meta;
type Story = StoryObj<typeof meta>;

export const LoadingEarlierMessages: Story = {
  args: {
    loadingSession: false,
    messages: [startupMessage],
    history: { status: 'loading', loadOlder: () => undefined },
    scroll: {
      identity: 'history',
      active: true,
      ready: true,
      initialIntent: 'reading',
      initialPosition: null,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('Loading earlier messages…')).toBeVisible();
  },
};

export const EarlierMessagesFailed: Story = {
  args: {
    ...LoadingEarlierMessages.args,
    history: {
      status: 'error',
      error: 'Could not load earlier messages.',
      loadOlder: () => undefined,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('button', { name: /^Retry$/ })).toBeVisible();
  },
};

export const CompleteHistory: Story = {
  args: {
    ...LoadingEarlierMessages.args,
    history: { status: 'complete', loadOlder: () => undefined },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByText('Beginning of conversation')
    ).not.toBeInTheDocument();
  },
};

export const EarlierMessagesDisconnected: Story = {
  args: {
    ...LoadingEarlierMessages.args,
    history: { status: 'idle', enabled: false, loadOlder: () => undefined },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole('button', { name: 'Load earlier messages' })
    ).not.toBeInTheDocument();
  },
};

export const EarlierMessagesLoadAutomatically: Story = {
  render: (args) => {
    const [status, setStatus] = useState<'idle' | 'complete'>('idle');
    return (
      <ChatTranscript
        {...args}
        history={{ status, enabled: true, loadOlder: () => setStatus('complete') }}
        messages={
          status === 'complete'
            ? [createUserMessage('Earlier message'), startupMessage]
            : [startupMessage]
        }
      />
    );
  },
  args: {
    loadingSession: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Earlier message')).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Load earlier messages' })
    ).not.toBeInTheDocument();
  },
};

/** A fast empty history check must not insert a loading row above the messages. */
export const FastHistoryCheck: Story = {
  render: (args) => {
    const [status, setStatus] = useState<'idle' | 'loading' | 'complete'>('idle');
    useEffect(() => {
      if (status !== 'loading') {
        return;
      }
      const timer = setTimeout(() => setStatus('complete'), 100);
      return () => clearTimeout(timer);
    }, [status]);
    return (
      <>
        <button type="button" onClick={() => setStatus('loading')}>
          Check history
        </button>
        {status === 'complete' && <span>History check complete</span>}
        <ChatTranscript
          {...args}
          history={{ status, enabled: false, loadOlder: () => undefined }}
        />
      </>
    );
  },
  args: { ...LoadingEarlierMessages.args },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let appeared = false;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        // Inspect added nodes too: a transient row may already be detached by
        // the time this callback runs.
        if (
          [record.target, ...record.addedNodes].some((node) =>
            node.textContent?.includes('Loading earlier messages…')
          )
        ) {
          appeared = true;
        }
      }
    });
    observer.observe(canvasElement, { childList: true, subtree: true, characterData: true });
    try {
      await userEvent.click(canvas.getByRole('button', { name: 'Check history' }));
      await canvas.findByText('History check complete');
      await expect(appeared).toBe(false);
    } finally {
      observer.disconnect();
    }
  },
};
