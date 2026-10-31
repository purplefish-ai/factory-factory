// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, forwardRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, type Mock, vi } from 'vitest';
import { collectAttachments } from '@/client/features/composer';
import { actFlushSync } from '@/test-utils/react-act';
import { InlineWorkspaceForm } from './inline-workspace-form';
import { loadWorkspaceCreationDraft } from './workspace-creation-draft-storage';

interface FormMocks {
  userSettings: {
    ratchetEnabled: boolean;
    defaultSessionProvider: string;
    defaultClaudeModel: string;
    defaultCodexModel: string;
  };
  settingsUnavailable: boolean;
  settingsLoading: boolean;
  settingsError: Error | null;
  agentMutationOptions?: {
    onSuccess: (
      task: { name: string; projectId: string },
      input?: unknown,
      context?: unknown
    ) => unknown;
    onError?: (error: Error, input?: unknown, context?: unknown) => unknown;
    onMutate?: () => unknown;
  };
  createWorkspaceMutationOptions?: Record<string, unknown>;
  workspaceListCache?: { workspaces: Array<{ id: string }>; reviewCount: number };
  createPeriodicTaskMutateMock: Mock;
  navigationSummaryInvalidate: Mock;
  detectFileMentionMock: Mock;
  toastErrorMock: Mock;
  listForProjectCancelMock: Mock;
  listForProjectGetDataMock: Mock;
  listForProjectSetDataMock: Mock;
  listForProjectInvalidateMock: Mock;
  getSetDataMock: Mock;
  createWorkspaceMutateMock: Mock;
}

const mocks: FormMocks = vi.hoisted(() => ({
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
  navigationSummaryInvalidate: vi.fn(),
  agentMutationOptions: undefined as
    | { onSuccess: (task: { name: string; projectId: string }) => void }
    | undefined,
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
    success: vi.fn(),
  },
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    codexAccounts: {
      list: {
        useQuery: () => ({
          data: [
            { id: 'native', label: 'Personal', authenticated: true, enabled: true },
            { id: 'work', label: 'Work', authenticated: true, enabled: true },
          ],
        }),
      },
    },
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
        navigationSummary: { invalidate: mocks.navigationSummaryInvalidate },
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
        useMutation: (options: typeof mocks.agentMutationOptions) => {
          mocks.agentMutationOptions = options;
          return { mutate: mocks.createPeriodicTaskMutateMock, isPending: false };
        },
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
  AccessModeSelector: () => null,
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
        'aria-label': `Planning: ${control.enabled ? 'On' : 'Off'}`,
        onClick: () => control.onChange(!control.enabled),
      },
      showLabel ? (control.enabled ? 'On' : 'Off') : null
    ),
  SessionLaunchControls: ({
    provider,
    model,
    onProviderChange,
    onModelChange,
    models,
    reasoning,
    planMode,
    account,
    children,
  }: import('@/client/features/session-selection').SessionLaunchControlsProps) =>
    createElement(
      'div',
      { 'aria-label': 'New conversation provider and model' },
      `${provider} ${model}`,
      account &&
        createElement(
          'button',
          { 'aria-label': 'Choose Work account', onClick: () => account.onChange('work') },
          'Work'
        ),
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
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange?: (value: string) => void;
  }) =>
    createElement(
      'div',
      {
        onClick: (event: React.MouseEvent<HTMLElement>) => {
          const value = (event.target as HTMLElement)
            .closest('[data-select-value]')
            ?.getAttribute('data-select-value');
          if (value) {
            onValueChange?.(value);
          }
        },
      },
      children
    ),
  SelectContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) =>
    createElement('div', { 'data-select-value': value }, children),
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

vi.mock('@/client/features/codex-accounts', () => ({
  CodexAccountPicker: ({ onChange }: { onChange: (id: string) => void }) =>
    createElement(
      'button',
      { 'aria-label': 'Choose Work account', onClick: () => onChange('work') },
      'Work'
    ),
}));

export function textareaLabel(container: HTMLElement) {
  const textarea = container.querySelector('textarea');
  return container.querySelector(`label[for="${textarea?.id}"]`)?.textContent;
}

const formRoots = new Set<Root>();

export function renderForm(
  projectId = getTestProjectId(),
  callbacks: { onCreated?: (id: string) => void; onCancel?: () => void } = {}
): {
  container: HTMLDivElement;
  root: Root;
  textarea: HTMLTextAreaElement;
  onCreated: (id: string) => void;
  onCancel: () => void;
} {
  const onCreated = callbacks.onCreated ?? vi.fn();
  const onCancel = callbacks.onCancel ?? vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient();
  formRoots.add(root);
  const unmount = root.unmount.bind(root);
  root.unmount = () => {
    if (!formRoots.delete(root)) {
      return;
    }
    unmount();
    queryClient.clear();
  };
  const render = root.render.bind(root);
  root.render = (children) =>
    render(createElement(QueryClientProvider, { client: queryClient }, children));

  actFlushSync(() => {
    root.render(
      createElement(InlineWorkspaceForm, {
        projectId,
        existingNames: [],
        onCancel,
        onCreated,
      })
    );
  });

  const textarea = container.querySelector('textarea');
  if (!textarea) {
    throw new Error('Expected textarea to render');
  }

  return { container, root, textarea, onCreated, onCancel };
}

let testProjectId = '';
export function getTestProjectId() {
  return testProjectId;
}

beforeEach(async () => {
  testProjectId = crypto.randomUUID();
  mocks.createWorkspaceMutateMock.mockReset();
  mocks.createPeriodicTaskMutateMock.mockReset();
  // These form tests deliberately exercise in-memory editing with unavailable disk.
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await expect(loadWorkspaceCreationDraft(testProjectId)).rejects.toThrow('could not be restored');
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
  actFlushSync(() => {
    for (const root of [...formRoots]) {
      root.unmount();
    }
  });
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

export { mocks };
export function createFormElement(
  props: React.ComponentProps<typeof InlineWorkspaceForm>
): React.ReactElement {
  return createElement(InlineWorkspaceForm, props);
}

export const collectAttachmentsMock: Mock<typeof collectAttachments> =
  vi.mocked(collectAttachments);
