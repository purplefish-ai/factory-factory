// @vitest-environment jsdom

import { createElement, forwardRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineWorkspaceForm } from './inline-workspace-form';

const mocks = vi.hoisted(() => ({
  detectFileMentionMock: vi.fn(),
  toastErrorMock: vi.fn(),
  listForProjectCancelMock: vi.fn(),
  listForProjectGetDataMock: vi.fn(),
  listForProjectSetDataMock: vi.fn(),
  listForProjectInvalidateMock: vi.fn(),
  getSetDataMock: vi.fn(),
  createWorkspaceMutateMock: vi.fn(),
  createWorkspaceMutationOptions: undefined as Record<string, unknown> | undefined,
  workspaceListCache: undefined as
    | { workspaces: Array<{ id: string }>; reviewCount: number }
    | undefined,
}));

vi.mock('@phosphor-icons/react', () => ({
  ArrowsClockwiseIcon: () => null,
  CalendarIcon: () => null,
  CaretDownIcon: () => null,
  PaperclipIcon: () => null,
  SpinnerGapIcon: () => null,
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
        listForProject: {
          cancel: mocks.listForProjectCancelMock,
          getData: mocks.listForProjectGetDataMock,
          setData: mocks.listForProjectSetDataMock,
          invalidate: mocks.listForProjectInvalidateMock,
        },
      },
      periodicTask: {
        list: { invalidate: vi.fn() },
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
    periodicTask: {
      create: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
        }),
      },
    },
    project: {
      listSlashCommands: {
        useQuery: () => ({
          data: { commands: [] },
          isFetched: true,
        }),
      },
    },
  },
}));

vi.mock('@/client/lib/workspace-cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/lib/workspace-cache-helpers')>()),
  createOptimisticWorkspaceCacheData: vi.fn(),
}));

// One factory for the whole composer, because the form now consumes it through
// a single barrel. Everything the form imports has to appear here: a partial
// factory leaves the rest undefined rather than falling through to the real
// module.
vi.mock('@/client/features/composer', () => ({
  AttachmentPreview: () => null,
  FileMentionPalette: () => null,
  SlashCommandPalette: () => null,
  collectAttachments: vi.fn(),
  usePasteDropHandler: () => ({
    handlePaste: vi.fn(),
    handleDrop: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    isDragging: false,
  }),
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
  useSlashCommands: () => ({
    slashMenuOpen: false,
    slashFilter: '',
    commandsReady: true,
    paletteRef: { current: null },
    handleInputChange: vi.fn(),
    handleSlashCommandSelect: vi.fn(),
    handleSlashMenuClose: vi.fn(),
    delegateToSlashMenu: () => 'passthrough',
  }),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: import('react').ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', props, children),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) =>
    createElement('div', { onClick }, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
}));

vi.mock('@/components/ui/input', () => ({
  Input: (props: import('react').InputHTMLAttributes<HTMLInputElement>) =>
    createElement('input', props),
}));

vi.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: import('react').LabelHTMLAttributes<HTMLLabelElement>) =>
    createElement('label', props, children),
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

vi.mock('@/client/features/workspace', () => ({
  RatchetToggleButton: () => createElement('button', { 'aria-label': 'Toggle ratchet' }),
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
  mocks.workspaceListCache = undefined;
  mocks.createWorkspaceMutationOptions = undefined;
  mocks.listForProjectCancelMock.mockResolvedValue(undefined);
  mocks.listForProjectGetDataMock.mockImplementation(() => mocks.workspaceListCache);
  mocks.listForProjectSetDataMock.mockImplementation((_input, updater) => {
    mocks.workspaceListCache =
      typeof updater === 'function' ? updater(mocks.workspaceListCache) : updater;
    return mocks.workspaceListCache;
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('InlineWorkspaceForm', () => {
  it('shows workspace-only toolbar controls in standard mode', () => {
    const { container, root } = renderForm();

    expect(container.querySelector('[aria-label="Toggle ratchet"]')).not.toBeNull();
    expect(container.textContent).toContain('Claude');
    expect(container.textContent).toContain('Codex');
    expect(container.textContent).toContain('Default');
    expect(container.textContent).toContain('Plan');
    expect(container.querySelectorAll('[aria-label="Attach files"]')).toHaveLength(2);

    root.unmount();
    container.remove();
  });

  it('hides ignored workspace-only toolbar controls in periodic task mode', () => {
    const { container, root } = renderForm();
    const periodicTaskItem = Array.from(container.querySelectorAll('div')).find(
      (element) => element.textContent === 'Create Periodic Task'
    );

    if (!periodicTaskItem) {
      throw new Error('Expected periodic task menu item to render');
    }

    flushSync(() => {
      periodicTaskItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[aria-label="Toggle ratchet"]')).toBeNull();
    expect(container.textContent).not.toContain('Claude');
    expect(container.textContent).not.toContain('Codex');
    expect(container.textContent).not.toContain('Default');
    expect(container.textContent).not.toContain('Plan');
    expect(container.querySelectorAll('[aria-label="Attach files"]')).toHaveLength(0);
    expect(container.textContent).toContain('Periodic task config');
    expect(container.textContent).toContain('Daily');

    root.unmount();
    container.remove();
  });

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

  it('drops only the optimistic row when workspace creation fails', async () => {
    // Rolling the whole cache back to its pre-mutation value would also revert
    // snapshot deltas that arrived during the create, and this cache backs the
    // sidebar too.
    mocks.workspaceListCache = { workspaces: [{ id: 'ws-existing' }], reviewCount: 3 };

    const { container, root } = renderForm();
    const mutationOptions = mocks.createWorkspaceMutationOptions as {
      onMutate: (input: {
        type: 'MANUAL';
        projectId: string;
        name: string;
        ratchetEnabled?: boolean;
      }) => Promise<{ optimisticWorkspaceId: string }>;
      onError: (error: Error, input: unknown, context: unknown) => void;
    };

    const context = await mutationOptions.onMutate({
      type: 'MANUAL',
      projectId: 'project-1',
      name: 'New Workspace',
      ratchetEnabled: true,
    });

    expect(mocks.workspaceListCache?.workspaces).toHaveLength(2);
    expect(mocks.workspaceListCache?.workspaces[0]).toMatchObject({
      id: context.optimisticWorkspaceId,
      name: 'New Workspace',
    });

    // A snapshot delta lands while the create is still in flight.
    mocks.workspaceListCache?.workspaces.push({ id: 'ws-live' });
    mutationOptions.onError(new Error('boom'), undefined, context);

    expect(mocks.workspaceListCache?.workspaces.map((workspace) => workspace.id)).toEqual([
      'ws-existing',
      'ws-live',
    ]);
    expect(mocks.workspaceListCache?.reviewCount).toBe(3);
    expect(mocks.toastErrorMock).toHaveBeenCalledWith('Failed to create workspace: boom');

    root.unmount();
    container.remove();
  });
});
