import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import type { MessageAttachment } from '@/lib/chat-protocol';
import {
  createPlanApprovalRequest,
  createTokenStats,
  createUserMessage,
  createUserQuestion,
} from '@/lib/claude-fixtures';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
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

function MockConversation() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scroll = useAutoScroll(viewportRef);
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
        <ChatContent
          workspaceId="scroll-button-story"
          sessionId={null}
          messages={messages}
          sessionStatus={{ phase: 'ready' }}
          sessionRuntime={createInitialSessionRuntimeState()}
          messagesEndRef={messagesEndRef}
          viewportRef={viewportRef}
          {...scroll}
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
            attachments: { enabled: true, kinds: ['text'] },
          }}
          updateSettings={noop}
          inputDraft={draft}
          setInputDraft={setDraft}
          inputAttachments={attachments}
          setInputAttachments={setAttachments}
          queuedMessages={[]}
          removeQueuedMessage={noop}
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
