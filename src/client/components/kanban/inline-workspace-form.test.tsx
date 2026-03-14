// @vitest-environment jsdom

import { createElement, forwardRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineWorkspaceForm } from './inline-workspace-form';

const mocks = vi.hoisted(() => ({
  detectFileMentionMock: vi.fn(),
  toastErrorMock: vi.fn(),
  listWithKanbanStateCancelMock: vi.fn(),
  listWithKanbanStateGetDataMock: vi.fn(),
  listWithKanbanStateSetDataMock: vi.fn(),
  listWithKanbanStateInvalidateMock: vi.fn(),
  listInvalidateMock: vi.fn(),
  getProjectSummaryStateInvalidateMock: vi.fn(),
  getSetDataMock: vi.fn(),
  createWorkspaceMutateMock: vi.fn(),
  createWorkspaceMutationOptions: undefined as Record<string, unknown> | undefined,
  kanbanCache: undefined as unknown[] | undefined,
}));

vi.mock('lucide-react', () => ({
  Loader2: () => null,
  Paperclip: () => null,
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastErrorMock,
  },
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        get: { setData: mocks.getSetDataMock },
        listWithKanbanState: {
          cancel: mocks.listWithKanbanStateCancelMock,
          getData: mocks.listWithKanbanStateGetDataMock,
          setData: mocks.listWithKanbanStateSetDataMock,
          invalidate: mocks.listWithKanbanStateInvalidateMock,
        },
        list: { invalidate: mocks.listInvalidateMock },
        getProjectSummaryState: { invalidate: mocks.getProjectSummaryStateInvalidateMock },
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
        useMutation: (options: Record<string, unknown>) => {
          mocks.createWorkspaceMutationOptions = options;
          return {
            mutate: mocks.createWorkspaceMutateMock,
            isPending: false,
          };
        },
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
    detectFileMention: mocks.detectFileMentionMock,
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
  mocks.kanbanCache = undefined;
  mocks.createWorkspaceMutationOptions = undefined;
  mocks.listWithKanbanStateCancelMock.mockResolvedValue(undefined);
  mocks.listWithKanbanStateGetDataMock.mockImplementation(() => mocks.kanbanCache);
  mocks.listWithKanbanStateSetDataMock.mockImplementation((_input, updater) => {
    mocks.kanbanCache = typeof updater === 'function' ? updater(mocks.kanbanCache) : updater;
    return mocks.kanbanCache;
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

    expect(mocks.detectFileMentionMock).toHaveBeenCalledWith('Investigate clipping');
    expect(textarea.style.height).toBe('180px');
    expect(textarea.style.overflowY).toBe('hidden');

    root.unmount();
    container.remove();
  });

  it('restores an empty kanban cache when optimistic workspace creation fails', async () => {
    const { container, root } = renderForm();
    const mutationOptions = mocks.createWorkspaceMutationOptions as {
      onMutate: (input: {
        type: 'MANUAL';
        projectId: string;
        name: string;
        ratchetEnabled?: boolean;
      }) => Promise<{ optimisticWorkspaceId: string; previousWorkspaces: unknown[] | undefined }>;
      onError: (error: Error, input: unknown, context: unknown) => void;
    };

    const context = await mutationOptions.onMutate({
      type: 'MANUAL',
      projectId: 'project-1',
      name: 'New Workspace',
      ratchetEnabled: true,
    });

    expect(Array.isArray(mocks.kanbanCache)).toBe(true);
    expect(mocks.kanbanCache).toHaveLength(1);
    expect(mocks.kanbanCache?.[0]).toMatchObject({
      id: context.optimisticWorkspaceId,
      name: 'New Workspace',
    });

    mutationOptions.onError(new Error('boom'), undefined, context);

    expect(mocks.listWithKanbanStateSetDataMock).toHaveBeenLastCalledWith(
      { projectId: 'project-1' },
      undefined
    );
    expect(mocks.kanbanCache).toBeUndefined();
    expect(mocks.toastErrorMock).toHaveBeenCalledWith('Failed to create workspace: boom');

    root.unmount();
    container.remove();
  });
});
