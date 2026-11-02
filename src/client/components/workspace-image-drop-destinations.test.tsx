// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatState } from '@/client/features/chat/use-chat-state';
import { useWorkspaceCreationDraft } from '@/client/features/kanban/use-workspace-creation-draft';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import { WorkspaceChatImageDropZone } from '@/client/routes/projects/workspaces/workspace-chat-image-drop-zone';
import { SidebarProvider } from '@/components/ui/sidebar';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { AppSidebar } from './app-sidebar';

vi.mock('@/client/hooks/use-project-issues', () => ({ useProjectIssues: () => ({ issues: [] }) }));
vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));
vi.mock('./theme-toggle', () => ({ ThemeToggle: () => null }));
// Keep draft storage real; the creation form's provider/backend discovery is unrelated to drop routing.
vi.mock('@/client/features/kanban/inline-workspace-form', () => ({
  InlineWorkspaceForm: ({ projectId }: { projectId: string }) => {
    const { draft } = useWorkspaceCreationDraft(projectId);
    return (
      <section aria-label="New workspace">
        {draft.attachments.map(({ id, name }) => (
          <span key={id}>{name}</span>
        ))}
      </section>
    );
  },
}));

const navigation: AppNavigationData = {
  projects: [],
  projectsError: null,
  refetchProjects: vi.fn(),
  selectedProjectSlug: 'drop-project',
  selectedProjectId: 'drop-project',
  selectProjectSlug: vi.fn(),
  issueProvider: 'GITHUB',
  serverWorkspaces: [],
  reviewCount: 0,
  agentsSummary: undefined,
  needsAttention: () => false,
  clearAttention: vi.fn(),
  currentWorkspaceId: 'workspace',
};

function MainChat({ sessionId }: { sessionId: string }) {
  const chat = useChatState({ dbSessionId: sessionId, send: () => true, connected: true });
  const { inputAttachments: attachments, setInputAttachments: setAttachments, inputRef } = chat;
  return (
    <WorkspaceChatImageDropZone
      workspaceId="workspace"
      sessionId={sessionId}
      connected
      sessionStatus={{ phase: 'ready' }}
      chatCapabilities={{
        ...EMPTY_CHAT_BAR_CAPABILITIES,
        attachments: { enabled: true, kinds: ['image', 'text'] },
      }}
      inputDraftGeneration={chat.inputDraftGeneration}
      inputAttachments={attachments}
      setInputAttachments={setAttachments}
      inputRef={inputRef}
    >
      <section aria-label="Conversation">
        <p>Transcript</p>
        <button type="button" onClick={() => chat.sendMessage('Send current draft')}>
          Send
        </button>
        <button type="button" onClick={() => setAttachments([])}>
          Clear attachments
        </button>
        <textarea aria-label="Message" ref={inputRef} />
        {attachments.map(({ id, name }) => (
          <span key={id}>{name}</span>
        ))}
      </section>
    </WorkspaceChatImageDropZone>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(sessionId = 'session-a') {
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={['/projects/drop-project/workspaces/workspace']}>
        <SidebarProvider>
          <AppSidebar navData={navigation} />
          <MainChat sessionId={sessionId} />
        </SidebarProvider>
      </MemoryRouter>
    )
  );
}
async function drag(target: Element, type: 'dragenter' | 'drop', name = 'sidebar.png') {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      items: [{ kind: 'file', type: 'image/png' }],
      files: type === 'drop' ? [new File(['image'], name, { type: 'image/png' })] : [],
    },
  });
  await act(() => target.dispatchEvent(event));
}

it('routes sidebar images to new workspace creation and transcript images only to the message', async () => {
  await render();
  const sidebar = container.querySelector('[data-sidebar="content"]')!;
  const conversation = container.querySelector('[aria-label="Conversation"]')!;
  await drag(sidebar, 'dragenter');
  expect(container.querySelector('[role="status"]')?.textContent).toContain('new workspace');
  await drag(sidebar, 'drop');
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="New workspace"]')?.textContent).toContain(
        'sidebar.png'
      )
    );
  });
  expect(conversation.textContent).not.toContain('sidebar.png');

  await drag(conversation.querySelector('p')!, 'dragenter', 'message.png');
  expect(container.querySelector('[role="status"]')?.textContent).toContain('your message');
  await drag(conversation.querySelector('p')!, 'drop', 'message.png');
  await act(async () => {
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(container.querySelector('[aria-label="Message"]'))
    );
  });
  expect(conversation.textContent).toContain('message.png');
  expect(container.querySelector('[aria-label="New workspace"]')?.textContent).not.toContain(
    'message.png'
  );
  expect(document.activeElement).toBe(container.querySelector('[aria-label="Message"]'));
});

it('does not deliver slow chat reads into a newly selected session', async () => {
  let finishRead: (() => void) | undefined;
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
    finishRead = () => {
      Object.defineProperty(this, 'result', { value: 'data:image/png;base64,aW1hZ2U=' });
      this.dispatchEvent(new ProgressEvent('load'));
    };
  });
  try {
    await render();
    await drag(container.querySelector('[aria-label="Conversation"]')!, 'drop', 'late-chat.png');
    await render('session-b');
    expect(finishRead).toBeDefined();
    await act(async () => {
      finishRead!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[aria-label="Conversation"]')?.textContent).not.toContain(
      'late-chat.png'
    );
  } finally {
    vi.restoreAllMocks();
  }
});

it.each(['Send', 'Clear attachments'])(
  'does not restore a pending image after %s clears the chat draft',
  async (action) => {
    let finishRead: (() => void) | undefined;
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      finishRead = () => {
        Object.defineProperty(this, 'result', { value: 'data:image/png;base64,aW1hZ2U=' });
        this.dispatchEvent(new ProgressEvent('load'));
      };
    });
    try {
      await render();
      const conversation = container.querySelector('[aria-label="Conversation"]')!;
      await drag(conversation, 'drop', 'canceled.png');
      expect(finishRead).toBeDefined();
      const button = [...conversation.querySelectorAll('button')].find(
        (item) => item.textContent === action
      )!;
      await act(() => button.click());
      await act(async () => {
        finishRead!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(conversation.textContent).not.toContain('canceled.png');
    } finally {
      vi.restoreAllMocks();
    }
  }
);

it('retains both overlapping image drops when reads complete before React commits', async () => {
  const finishReads: Array<() => void> = [];
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
    finishReads.push(() => {
      Object.defineProperty(this, 'result', { value: 'data:image/png;base64,aW1hZ2U=' });
      this.dispatchEvent(new ProgressEvent('load'));
    });
  });
  try {
    await render();
    const conversation = container.querySelector('[aria-label="Conversation"]')!;
    await drag(conversation, 'drop', 'first.png');
    await drag(conversation, 'drop', 'second.png');
    expect(finishReads).toHaveLength(2);
    await act(async () => {
      finishReads.forEach((finish) => finish());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(conversation.textContent).toContain('first.png');
    expect(conversation.textContent).toContain('second.png');
    expect(sessionStorage.getItem('chat-attachments-session-a')).toContain('first.png');
    expect(sessionStorage.getItem('chat-attachments-session-a')).toContain('second.png');
  } finally {
    vi.restoreAllMocks();
  }
});
