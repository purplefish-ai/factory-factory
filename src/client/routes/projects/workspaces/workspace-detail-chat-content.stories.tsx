import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Button } from '@/components/ui/button';
import type { MessageAttachment } from '@/lib/chat-protocol';
import {
  createPlanApprovalRequest,
  createTokenStats,
  createUserMessage,
  createUserQuestion,
} from '@/lib/claude.fixture';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { createInitialSessionRuntimeState, type SessionWorkState } from '@/shared/session-runtime';
import { WorkspaceChatImageDropZone } from './workspace-chat-image-drop-zone';
import { ChatContent, type ChatContentProps } from './workspace-detail-chat-content';

const messages = Array.from({ length: 40 }, (_, index) =>
  createUserMessage(`Mock conversation message ${index + 1}. This is local fixture content.`)
);
const plan = createPlanApprovalRequest(
  Array.from({ length: 40 }, (_, index) => `Step ${index + 1}: Verify the local layout.`).join(
    '\n\n'
  )
);
const question = createUserQuestion([
  {
    question: 'Which local layout should we check?',
    options: [
      { label: 'Narrow', description: 'A phone-sized chat panel' },
      { label: 'Wide', description: 'A desktop-sized chat panel' },
    ],
  },
]);
const noop = () => undefined;

function storyRuntime(work?: SessionWorkState, runtimeError?: string) {
  if (runtimeError) {
    return {
      ...createInitialSessionRuntimeState(),
      phase: 'error' as const,
      processState: 'alive' as const,
      errorMessage: runtimeError,
    };
  }
  return work
    ? {
        ...createInitialSessionRuntimeState(),
        phase: 'running' as const,
        processState: 'alive' as const,
        activity: 'WORKING' as const,
        work,
      }
    : createInitialSessionRuntimeState();
}

function MockConversation({
  work,
  runtimeError,
  onSendMessage = noop,
  onRestartSession = noop,
}: {
  work?: SessionWorkState;
  runtimeError?: string;
  onSendMessage?: ChatContentProps['sendMessage'];
  onRestartSession?: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [pendingRequest, setPendingRequest] = useState<ChatContentProps['pendingRequest']>({
    type: 'none',
  });

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap gap-2 p-2">
        <Button
          size="sm"
          onClick={() =>
            setAttachments([
              {
                id: 'local-attachment',
                name: 'Local notes.txt',
                type: 'text/plain',
                contentType: 'text',
                size: 20,
                data: 'Local fixture notes',
              },
            ])
          }
        >
          Add mock attachment
        </Button>
        <Button size="sm" onClick={() => setAttachments([])}>
          Clear attachments
        </Button>
        <Button size="sm" onClick={() => setPendingRequest({ type: 'permission', request: plan })}>
          Show plan
        </Button>
        <Button
          size="sm"
          onClick={() => setPendingRequest({ type: 'question', request: question })}
        >
          Show question
        </Button>
        <Button size="sm" onClick={() => setPendingRequest({ type: 'none' })}>
          Clear prompt
        </Button>
      </div>
      <div className="min-h-0 flex-1" data-testid="mock-conversation">
        <WorkspaceChatImageDropZone
          workspaceId="scroll-button-story"
          sessionId="story-session"
          connected
          sessionStatus={{ phase: work ? 'running' : 'ready' }}
          chatCapabilities={{
            ...EMPTY_CHAT_BAR_CAPABILITIES,
            attachments: { enabled: true, kinds: ['image', 'text'] },
          }}
          inputAttachments={attachments}
          setInputAttachments={setAttachments}
          inputRef={inputRef}
        >
          <ChatContent
            workspaceId="scroll-button-story"
            sessionId="story-session"
            messages={messages}
            sessionStatus={{ phase: work ? 'running' : 'ready' }}
            sessionRuntime={storyRuntime(work, runtimeError)}
            transcriptScroll={{
              identity: 'main-story',
              active: true,
              ready: true,
              initialIntent: 'following',
              initialPosition: null,
            }}
            pendingRequest={pendingRequest}
            approvePermission={noop}
            answerQuestion={noop}
            connected
            sendMessage={onSendMessage}
            stopChat={noop}
            restartSession={onRestartSession}
            inputRef={inputRef}
            chatSettings={{
              selectedModel: 'sonnet',
              reasoningEffort: 'medium',
              thinkingEnabled: false,
              planModeEnabled: false,
            }}
            chatCapabilities={{
              ...EMPTY_CHAT_BAR_CAPABILITIES,
              attachments: { enabled: true, kinds: ['image', 'text'] },
            }}
            updateSettings={noop}
            inputDraft={draft}
            setInputDraft={setDraft}
            inputAttachments={attachments}
            setInputAttachments={setAttachments}
            queuedMessages={[]}
            removeQueuedMessage={noop}
            steerQueuedMessage={noop}
            resumeQueuedMessages={noop}
            latestThinking={null}
            pendingMessages={new Map()}
            isCompacting={false}
            slashCommands={[]}
            slashCommandsLoaded
            tokenStats={createTokenStats()}
            acpConfigOptions={null}
            setConfigOption={noop}
            initBanner={null}
            isScriptFailed={false}
          />
        </WorkspaceChatImageDropZone>
      </div>
    </div>
  );
}

const meta = {
  title: 'Workspace/ChatContent',
  component: MockConversation,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof MockConversation>;

export default meta;
type Story = StoryObj<typeof meta>;

// All callbacks stay local; this story never starts a session or sends messages.
export const ComposerHeightChanges: Story = { render: () => <MockConversation /> };

export const BackgroundProcessRunning: Story = {
  args: {
    work: {
      promptInFlight: false,
      backgroundTasks: [{ id: 'preview', name: 'pnpm dev', kind: 'shell' }],
      runningSubagents: 0,
      activeGoals: 0,
    },
  },
};

export const PromptInFlight: Story = {
  args: {
    work: {
      promptInFlight: true,
      backgroundTasks: [],
      runningSubagents: 0,
      activeGoals: 0,
    },
  },
};

export const MessageImageDrop: Story = {
  play: ({ canvasElement }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['image'], 'reference.png', { type: 'image/png' }));
    const target = canvasElement.querySelector('textarea');
    if (!target) {
      throw new Error('Message composer not found');
    }
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
  },
};

export const MessageImageDropWhileRunning: Story = {
  args: PromptInFlight.args,
  play: MessageImageDrop.play,
};

const LONG_RUNTIME_ERROR = [
  'Turn stopped: Claude returned HTTP 400 (invalid_request_error).',
  '{"type":"error","error":{"type":"invalid_request_error","message":"messages.12.content.3.tool_result: the tool_use_id toolu_01AbCdEf does not match any tool_use block in the previous assistant message."},"request_id":"req_011CXyZ"}',
].join('\n');

/**
 * The runtime error stays pinned above the composer however long the chat is;
 * Retry resends the last message and Restart reuses the session restart action.
 */
export const RuntimeErrorPinnedAboveComposer: Story = {
  args: {
    runtimeError: 'Turn stopped: Codex returned HTTP 529 (Overloaded).',
    onSendMessage: fn(),
    onRestartSession: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const strip = await canvas.findByTestId('agent-error-strip');
    await expect(within(strip).getByRole('alert')).toHaveTextContent('HTTP 529');
    await userEvent.click(within(strip).getByRole('button', { name: 'Retry' }));
    await expect(args.onSendMessage).toHaveBeenCalledWith(
      'Mock conversation message 40. This is local fixture content.',
      { preserveInput: true, attachments: [] }
    );
    await userEvent.click(within(strip).getByRole('button', { name: 'Restart agent' }));
    await expect(args.onRestartSession).toHaveBeenCalledTimes(1);
  },
};

export const RuntimeErrorPinnedAboveComposerDark: Story = {
  args: { runtimeError: 'Turn stopped: Codex returned HTTP 529 (Overloaded).' },
  globals: { theme: 'dark' },
};

export const RuntimeErrorLongTextPhone: Story = {
  args: { runtimeError: LONG_RUNTIME_ERROR },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const RuntimeErrorDismissed: Story = {
  args: { runtimeError: 'Agent process exited unexpectedly (code 137)' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Dismiss error' }));
    await expect(canvas.queryByTestId('agent-error-strip')).toBeNull();
  },
};
