// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, forwardRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import { InlineWorkspaceForm } from './inline-workspace-form';

const mocks = vi.hoisted(() => ({
  userSettings: {
    ratchetEnabled: false,
    defaultSessionProvider: 'CLAUDE',
    defaultClaudeModel: 'saved-sonnet',
    defaultCodexModel: 'saved-sol',
  },
  settingsUnavailable: false,
  settingsLoading: false,
  settingsError: null as Error | null,
  createPeriodicTaskMutateMock: vi.fn(),
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

vi.mock('@phosphor-icons/react/dist/csr/ArrowsClockwise', () => ({
  ArrowsClockwiseIcon: () => null,
}));
vi.mock('@phosphor-icons/react/dist/csr/Calendar', () => ({ CalendarIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/CaretDown', () => ({ CaretDownIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/Paperclip', () => ({ PaperclipIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/SpinnerGap', () => ({ SpinnerGapIcon: () => null }));

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
      getProviderOptions: {
        useQuery: () => ({
          data: {
            CLAUDE: {
              models: [
                { value: 'saved-sonnet', label: 'Saved Sonnet' },
                { value: 'catalog-opus', label: 'Opus' },
              ],
            },
            CODEX: {
              models: [
                { value: 'saved-sol', label: 'Saved Sol' },
                { value: 'chosen-model', label: 'Catalog Luna' },
              ],
            },
          },
          isLoading: false,
        }),
      },
      get: {
        useQuery: () => ({
          data: mocks.settingsUnavailable ? undefined : mocks.userSettings,
          isLoading: mocks.settingsLoading,
          error: mocks.settingsError,
        }),
      },
    },
    session: {
      getLaunchOptions: {
        useQuery: (input: { provider: 'CLAUDE' | 'CODEX'; model?: string }) => ({
          data: {
            provider: input.provider,
            model: input.model ?? 'native',
            reasoning: {
              options: [
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
              ],
              selected: 'medium',
              defaultValue: 'medium',
            },
            planMode: { supported: true, selected: false },
          },
          refetch: vi.fn(),
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
          mutate: mocks.createPeriodicTaskMutateMock,
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
  seedCreatedWorkspaceDetail: vi.fn(),
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
  useSlashCommands: ({ onChange }: { onChange?: (value: string) => void }) => ({
    slashMenuOpen: false,
    slashFilter: '',
    commandsReady: true,
    paletteRef: { current: null },
    handleInputChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      onChange?.(event.target.value),
    handleSlashCommandSelect: vi.fn(),
    handleSlashMenuClose: vi.fn(),
    delegateToSlashMenu: () => 'passthrough',
  }),
}));

vi.mock('@/client/features/session-selection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/features/session-selection')>()),
  PlanningSelector: ({
    control,
    showLabel,
  }: {
    control: { enabled: boolean; onChange: (value: boolean) => void };
    showLabel?: boolean;
  }) =>
    createElement(
      'button',
      {
        'aria-label': `Planning: ${control.enabled ? 'Plan' : 'Default'}`,
        onClick: () => control.onChange(!control.enabled),
      },
      control.enabled ? 'Plan' : showLabel ? 'Plan off' : 'Default'
    ),
  SessionLaunchControls: ({
    provider,
    model,
    onProviderChange,
    onModelChange,
    models,
    reasoning,
    planMode,
    children,
  }: import('@/client/features/session-selection').SessionLaunchControlsProps) =>
    createElement(
      'div',
      { 'aria-label': 'New conversation provider and model' },
      `${provider} ${model}`,
      reasoning &&
        createElement(
          'button',
          { 'aria-label': `Thinking level: ${reasoning.value ?? 'Default'}` },
          reasoning.value ?? 'Default'
        ),
      planMode &&
        createElement(
          'button',
          {
            'aria-label': 'Plan mode',
            'aria-pressed': planMode.enabled,
            onClick: () => planMode.onChange(!planMode.enabled),
          },
          'Plan'
        ),
      createElement(
        'button',
        { onClick: () => onProviderChange?.('CLAUDE'), 'aria-label': 'Choose Claude' },
        'Claude'
      ),
      createElement(
        'button',
        { onClick: () => onProviderChange?.('CODEX'), 'aria-label': 'Choose Codex' },
        'Codex'
      ),
      createElement(
        'button',
        {
          onClick: () => {
            const option = models.find((entry) => entry.value !== model);
            if (option) {
              onModelChange?.(option.value);
            }
          },
          'aria-label': 'Choose model',
        },
        model
      ),
      children
    ),
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
  const queryClient = new QueryClient();
  const render = root.render.bind(root);
  root.render = (children) =>
    render(createElement(QueryClientProvider, { client: queryClient }, children));

  actFlushSync(() => {
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
  mocks.userSettings = {
    ratchetEnabled: false,
    defaultSessionProvider: 'CLAUDE',
    defaultClaudeModel: 'saved-sonnet',
    defaultCodexModel: 'saved-sol',
  };
  mocks.settingsUnavailable = false;
  mocks.settingsLoading = false;
  mocks.settingsError = null;
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
  it('offers ordinary launch and periodic tasks without auto-iteration controls', () => {
    const { container, root } = renderForm();
    try {
      expect(container.textContent).toContain('Launch');
      expect(container.textContent).toContain('Create Periodic Task');
      expect(container.textContent).not.toMatch(/auto.iterat/i);
      expect(container.querySelector('#test-command')).toBeNull();
      expect(container.querySelector('#target-description')).toBeNull();
    } finally {
      actFlushSync(() => root.unmount());
    }
  });

  it('shows workspace-only toolbar controls in standard mode', () => {
    const { container, root } = renderForm();

    expect(container.querySelector('[aria-label="Toggle ratchet"]')).not.toBeNull();
    expect(container.textContent).toContain('CLAUDE');
    expect(
      container.querySelector('[aria-label^="New conversation provider and model"]')
    ).not.toBeNull();
    expect(container.querySelector('[aria-label^="Thinking level:"]')).not.toBeNull();
    expect(container.textContent).toContain('Plan');
    expect(container.querySelectorAll('[aria-label="Attach files"]')).toHaveLength(2);

    actFlushSync(() => root.unmount());
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

    actFlushSync(() => {
      periodicTaskItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[aria-label="Toggle ratchet"]')).toBeNull();
    expect(container.textContent).not.toContain('CLAUDE');
    expect(container.textContent).not.toContain('Codex');
    expect(container.textContent).not.toContain('Default');
    expect(container.textContent).not.toContain('Plan');
    expect(container.querySelectorAll('[aria-label="Attach files"]')).toHaveLength(0);
    expect(container.textContent).toContain('Periodic task config');
    expect(container.textContent).toContain('Daily');

    actFlushSync(() => root.unmount());
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

    actFlushSync(() => {
      setTextareaValue.call(textarea, 'Investigate clipping');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(mocks.detectFileMentionMock).toHaveBeenCalledWith('Investigate clipping');
    expect(textarea.style.height).toBe('180px');
    expect(textarea.style.overflowY).toBe('hidden');

    actFlushSync(() => root.unmount());
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
      worktreePath: null,
      name: 'New Workspace',
      prMonitoring: {
        deliveryMode: 'MAIN',
        enabled: true,
        recipientSessionId: null,
        bindingRevision: 0,
        pauseReason: null,
        pendingEventCount: 0,
      },
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

    actFlushSync(() => root.unmount());
    container.remove();
  });
});

it('sends the saved provider model when launching a workspace', () => {
  const { container, root } = renderForm();
  try {
    const launch = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Launch'
    );
    expect(launch).toBeDefined();
    actFlushSync(() => launch?.click());
    expect(mocks.createWorkspaceMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'CLAUDE', model: 'saved-sonnet' })
    );
  } finally {
    actFlushSync(() => root.unmount());
  }
});

it('retains the chosen provider and model when saved settings refetch during a workspace draft', () => {
  const { container, root } = renderForm();
  try {
    actFlushSync(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Choose Codex"]')?.click()
    );
    actFlushSync(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Choose model"]')?.click()
    );
    mocks.userSettings = {
      ...mocks.userSettings,
      defaultSessionProvider: 'CLAUDE',
      defaultCodexModel: 'changed-default',
    };
    actFlushSync(() =>
      root.render(
        createElement(InlineWorkspaceForm, {
          projectId: 'project-1',
          existingNames: [],
          onCancel: vi.fn(),
          onCreated: vi.fn(),
        })
      )
    );
    const launch = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Launch'
    );
    actFlushSync(() => launch?.click());
    expect(mocks.createWorkspaceMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'CODEX', model: 'chosen-model' })
    );
  } finally {
    actFlushSync(() => root.unmount());
  }
});

it.each(['loading', 'failed'])(
  'allows periodic task creation while chat defaults are %s',
  async (status) => {
    await act(() => {
      mocks.settingsUnavailable = true;
      mocks.settingsLoading = status === 'loading';
      mocks.settingsError = status === 'failed' ? new Error('Defaults failed') : null;
      const { container, root, textarea } = renderForm();
      try {
        const modeButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.className.includes('rounded-l-none')
        );
        expect(modeButton?.disabled).toBe(false);
        expect(
          [...container.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent === 'Launch'
          )?.disabled
        ).toBe(true);
        const periodicMode = [...container.querySelectorAll('div')].find(
          (element) => element.textContent === 'Create Periodic Task'
        );
        actFlushSync(() => periodicMode?.click());
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        actFlushSync(() => {
          setter?.call(textarea, 'Run the periodic review');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const create = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.textContent === 'Create Periodic Task'
        );
        expect(create?.disabled).toBe(false);
        actFlushSync(() => create?.click());
        expect(mocks.createPeriodicTaskMutateMock).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'project-1',
            prompt: 'Run the periodic review',
            cadence: 'DAILY',
          })
        );
        expect(mocks.createWorkspaceMutateMock).not.toHaveBeenCalled();
      } finally {
        actFlushSync(() => root.unmount());
      }
    });
  }
);

it('explains why keyboard workspace creation is blocked while defaults are unavailable', async () => {
  mocks.settingsUnavailable = true;
  mocks.settingsError = new Error('Defaults failed');
  await act(() => {
    const { root, textarea } = renderForm();
    try {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', metaKey: true })
      );
      expect(mocks.createWorkspaceMutateMock).not.toHaveBeenCalled();
      expect(mocks.toastErrorMock).toHaveBeenCalledWith('Could not load chat defaults');
    } finally {
      actFlushSync(() => root.unmount());
    }
  });
});
