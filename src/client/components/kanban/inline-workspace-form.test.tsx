// @vitest-environment jsdom

import { createElement, forwardRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineWorkspaceForm } from './inline-workspace-form';

const detectFileMentionMock = vi.fn();

vi.mock('lucide-react', () => ({
  Loader2: () => null,
  Paperclip: () => null,
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        get: { setData: vi.fn() },
        listWithKanbanState: { invalidate: vi.fn() },
        list: { invalidate: vi.fn() },
        getProjectSummaryState: { invalidate: vi.fn() },
      },
    }),
    userSettings: {
      get: {
        useQuery: () => ({
          data: {
            ratchetEnabled: false,
            defaultSessionProvider: 'CLAUDE',
          },
          isLoading: false,
        }),
      },
    },
    workspace: {
      list: {
        useQuery: () => ({
          data: [],
          isLoading: false,
        }),
      },
      create: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock('@/client/lib/workspace-cache-helpers', () => ({
  createOptimisticWorkspaceCacheData: vi.fn(),
}));

vi.mock('@/components/chat/attachment-preview', () => ({
  AttachmentPreview: () => null,
}));

vi.mock('@/components/chat/chat-input/hooks/attachment-file-conversion', () => ({
  collectAttachments: vi.fn(),
}));

vi.mock('@/components/chat/chat-input/hooks/use-paste-drop-handler', () => ({
  usePasteDropHandler: () => ({
    handlePaste: vi.fn(),
    handleDrop: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    isDragging: false,
  }),
}));

vi.mock('@/components/chat/chat-input/hooks/use-project-file-mentions', () => ({
  useProjectFileMentions: () => ({
    files: [],
    fileMentionMenuOpen: false,
    filesLoading: false,
    fileMentionFilter: '',
    handleFileMentionMenuClose: vi.fn(),
    handleFileMentionSelect: vi.fn(),
    delegateToFileMentionMenu: () => 'passthrough',
    detectFileMention: detectFileMentionMock,
    paletteRef: { current: null },
  }),
}));

vi.mock('@/components/chat/file-mention-palette', () => ({
  FileMentionPalette: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: import('react').ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', props, children),
}));

vi.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
  CardContent: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SelectContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SelectItem: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SelectTrigger: ({ children }: { children: ReactNode }) => createElement('button', null, children),
  SelectValue: () => null,
}));

vi.mock('@/components/ui/textarea', () => ({
  Textarea: forwardRef<HTMLTextAreaElement, import('react').ComponentProps<'textarea'>>(
    function Textarea(props, ref) {
      return createElement('textarea', { ...props, ref });
    }
  ),
}));

vi.mock('@/components/workspace', () => ({
  RatchetToggleButton: () => null,
}));

function renderForm(): {
  container: HTMLDivElement;
  root: Root;
  textarea: HTMLTextAreaElement;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(
      createElement(InlineWorkspaceForm, {
        projectId: 'project-1',
        existingNames: [],
        onCancel: vi.fn(),
        onCreated: vi.fn(),
      })
    );
  });

  const textarea = container.querySelector('textarea');
  if (!textarea) {
    throw new Error('Expected textarea to render');
  }

  return { container, root, textarea };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('InlineWorkspaceForm', () => {
  it('auto-resizes the textarea while typing normally', () => {
    const { container, root, textarea } = renderForm();
    const setTextareaValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;

    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      value: 180,
    });

    if (!setTextareaValue) {
      throw new Error('Expected textarea value setter');
    }

    flushSync(() => {
      setTextareaValue.call(textarea, 'Investigate clipping');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(detectFileMentionMock).toHaveBeenCalledWith('Investigate clipping');
    expect(textarea.style.height).toBe('180px');
    expect(textarea.style.overflowY).toBe('hidden');

    root.unmount();
    container.remove();
  });
});
