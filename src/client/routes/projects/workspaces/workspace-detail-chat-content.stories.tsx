import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { MessageAttachment } from '@/lib/chat-protocol';
import {
  createPlanApprovalRequest,
  createTokenStats,
  createUserMessage,
  createUserQuestion,
} from '@/lib/claude-fixtures';
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

function MockConversation({ work }: { work?: SessionWorkState }) {
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
          sessionStatus={{ phase: 'ready' }}
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
            sessionRuntime={
              work
                ? {
                    ...createInitialSessionRuntimeState(),
                    phase: 'running',
                    processState: 'alive',
                    activity: 'WORKING',
                    work,
                  }
                : createInitialSessionRuntimeState()
            }
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
            sendMessage={noop}
            stopChat={noop}
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
            rewindPreview={null}
            startRewindPreview={noop}
            confirmRewind={noop}
            cancelRewind={noop}
            getUuidForMessageId={() => undefined}
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
  title: 'Workspaces/ChatContent',
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
