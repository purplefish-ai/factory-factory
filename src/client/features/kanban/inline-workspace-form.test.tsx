import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { collectAttachments } from '@/client/features/composer';
import { actFlushSync } from '@/test-utils/react-act';
// @vitest-environment jsdom
import {
  collectAttachmentsMock,
  createFormElement,
  getTestProjectId,
  mocks,
  renderForm,
  textareaLabel,
} from './inline-workspace-form.test-harness';
import {
  getWorkspaceCreationDraftSnapshot,
  createWorkspaceCreationDraft,
  saveWorkspaceCreationDraft,
} from './workspace-creation-draft-storage';

describe('InlineWorkspaceForm', () => {
  it('offers ordinary launch and periodic tasks without auto-iteration controls', () => {
    const { container, root } = renderForm();
    try {
      expect(container.textContent).toContain('Launch');
      expect(container.textContent).toContain('Create Agent');
      expect(container.textContent).not.toMatch(/auto.iterat/i);
      expect(container.querySelector('#test-command')).toBeNull();
      expect(container.querySelector('#target-description')).toBeNull();
    } finally {
      actFlushSync(() => root.unmount());
    }
  });

  it('keeps model and thinking in the toolbar and groups secondary workspace settings', () => {
    const { container, root } = renderForm();

    expect(container.querySelector('[aria-label="Toggle ratchet"]')).toBeNull();
    expect(container.textContent).toContain('CLAUDE');
    expect(
      container.querySelector('[aria-label^="New conversation provider and model"]')
    ).not.toBeNull();
    expect(container.querySelector('[aria-label^="Thinking level:"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Plan');
    expect(container.querySelectorAll('[aria-label="Attach files"]')).toHaveLength(2);
    actFlushSync(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Workspace settings"]')?.click()
    );
    expect(document.body.querySelector('[aria-label="Toggle ratchet"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Plan mode');

    actFlushSync(() => root.unmount());
    container.remove();
  });

  it('hides ignored workspace-only toolbar controls in periodic task mode', () => {
    const { container, root } = renderForm();
    const periodicTaskItem = Array.from(container.querySelectorAll('div')).find(
      (element) => element.textContent === 'Create Agent'
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
    expect(container.textContent?.match(/Schedule/g)).toHaveLength(1);
    expect(textareaLabel(container)).toBe('Instructions');
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
      projectId: getTestProjectId(),
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
        createFormElement({
          projectId: getTestProjectId(),
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
          (element) => element.textContent === 'Create Agent'
        );
        actFlushSync(() => periodicMode?.click());
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        actFlushSync(() => {
          setter?.call(textarea, 'Run the periodic review');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const create = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.textContent === 'Create Agent'
        );
        expect(create?.disabled).toBe(false);
        actFlushSync(() => create?.click());
        expect(mocks.createPeriodicTaskMutateMock).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: getTestProjectId(),
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

it('creates an agent with shared schedule fields and clears time and timezone for minute schedules', () => {
  const { container, root, textarea } = renderForm();
  try {
    actFlushSync(() =>
      [...container.querySelectorAll('div')]
        .find((element) => element.textContent === 'Create Agent')
        ?.click()
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    actFlushSync(() => {
      setter?.call(textarea, '  Review changes  ');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const time = container.querySelector('input[type="time"]');
    const timeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    actFlushSync(() => {
      timeSetter?.call(time, '09:30');
      time?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const create = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Create Agent'
    );
    actFlushSync(() => create?.click());
    expect(mocks.createPeriodicTaskMutateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: 'Review changes',
        scheduledTime: '09:30',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    );
    actFlushSync(() => {
      mocks.agentMutationOptions?.onError?.(new Error('Change schedule before retry'));
    });
    actFlushSync(() =>
      container.querySelector<HTMLElement>('[data-select-value="EVERY_MINUTE"]')?.click()
    );
    expect(container.querySelector('input[type="time"]')).toBeNull();
    actFlushSync(() => create?.click());
    expect(mocks.createPeriodicTaskMutateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ cadence: 'EVERY_MINUTE', scheduledTime: null, timezone: null })
    );
  } finally {
    actFlushSync(() => root.unmount());
  }
});

it('invalidates the created agent owner summary after Kanban creation', () => {
  mocks.navigationSummaryInvalidate.mockClear();
  const { root, container } = renderForm();
  try {
    actFlushSync(() =>
      mocks.agentMutationOptions?.onSuccess({ name: 'Agent', projectId: 'origin' })
    );
    expect(mocks.navigationSummaryInvalidate).toHaveBeenCalledWith({ projectId: 'origin' });
  } finally {
    actFlushSync(() => root.unmount());
    container.remove();
  }
});

it('propagates a manual Codex account into the workspace launch request', () => {
  const { container, root } = renderForm();
  try {
    actFlushSync(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Choose Codex"]')?.click()
    );
    actFlushSync(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Workspace settings"]')?.click()
    );
    actFlushSync(() =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Choose Work account"]')?.click()
    );
    const launch = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Launch'
    );
    actFlushSync(() => launch?.click());
    expect(mocks.createWorkspaceMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'CODEX', codexAccountId: 'work' })
    );
  } finally {
    actFlushSync(() => root.unmount());
    container.remove();
  }
});

it('preserves an in-memory draft and allows clearing its text while disk storage is unavailable', async () => {
  const first = renderForm();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  actFlushSync(() => {
    setter?.call(first.textarea, 'A task worth keeping');
    first.textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  actFlushSync(() =>
    [...first.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Cancel')
      ?.click()
  );
  actFlushSync(() => first.root.unmount());
  const second = renderForm();
  expect(second.textarea.value).toBe('A task worth keeping');
  await act(() => Promise.resolve());
  expect(second.container.querySelector('[role="alert"]')?.textContent).toContain(
    'could not be saved'
  );
  const discard = [...second.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Discard draft'
  );
  expect(discard).toBeUndefined();
  expect(second.container.textContent).not.toContain('Reset saved draft');
  actFlushSync(() => {
    setter?.call(second.textarea, '');
    second.textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  actFlushSync(() => second.root.unmount());
  const third = renderForm();
  expect(third.textarea.value).toBe('');
  actFlushSync(() => third.root.unmount());
});

it('restores textarea height and provider choices after reopening', () => {
  const first = renderForm();
  actFlushSync(() =>
    first.container.querySelector<HTMLButtonElement>('[aria-label="Choose Codex"]')?.click()
  );
  actFlushSync(() =>
    first.container.querySelector<HTMLButtonElement>('[aria-label="Choose model"]')?.click()
  );
  actFlushSync(() => first.root.unmount());
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 180,
  });
  const second = renderForm();
  expect(second.container.textContent).toContain('CODEX chosen-model');
  expect(second.textarea.style.height).toBe('180px');
  actFlushSync(() => second.root.unmount());
  if (descriptor) {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', descriptor);
  } else {
    Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
  }
});

it('keeps late attachment conversion in its original project after switching', async () => {
  let finish: (result: Awaited<ReturnType<typeof collectAttachments>>) => void = () => {
    throw new Error('Attachment conversion did not start');
  };
  collectAttachmentsMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const mounted = renderForm();
  const input = mounted.container.querySelector<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [new File(['x'], 'notes.txt')] });
  actFlushSync(() => input?.dispatchEvent(new Event('change', { bubbles: true })));
  await act(() => {
    mounted.root.render(
      createFormElement({
        projectId: 'attachment-destination',
        existingNames: [],
        onCancel: vi.fn(),
        onCreated: vi.fn(),
      })
    );
  });
  await act(() =>
    finish({
      attachments: [
        {
          id: 'late',
          name: 'notes.txt',
          type: 'text/plain',
          size: 1,
          data: 'x',
          contentType: 'text',
        },
      ],
      errors: [],
    })
  );
  expect(
    getWorkspaceCreationDraftSnapshot('attachment-destination').draft?.attachments ?? []
  ).toEqual([]);
  expect(getWorkspaceCreationDraftSnapshot(getTestProjectId()).draft?.attachments[0]?.data).toBe(
    'x'
  );
  actFlushSync(() => mounted.root.unmount());
});

it('blocks launch only while restoring and makes storage failure visible', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('indexedDB', { open: () => ({}) });
  const mounted = renderForm('blocked-form');
  try {
    const launch = [...mounted.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Launch'
    );
    expect(launch?.disabled).toBe(true);
    expect(launch?.getAttribute('title')).toBe('Restoring draft');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(launch?.disabled).toBe(false);
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be restored'
    );
  } finally {
    actFlushSync(() => mounted.root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('restores periodic schedules and explicit ratchet settings without applying later defaults', async () => {
  await expect(
    saveWorkspaceCreationDraft(getTestProjectId(), {
      ...createWorkspaceCreationDraft(),
      prompt: 'Periodic review',
      mode: 'PERIODIC_TASK',
      cadence: 'WEEKLY',
      scheduledTime: '09:30',
      ratchetEnabled: true,
      ratchetInitialized: true,
    })
  ).rejects.toThrow('could not be saved');
  const mounted = renderForm();
  expect(mounted.textarea.value).toBe('Periodic review');
  expect(mounted.container.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe(
    '09:30'
  );
  actFlushSync(() =>
    [...mounted.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Create Agent')
      ?.click()
  );
  expect(mocks.createPeriodicTaskMutateMock).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: 'Periodic review',
      cadence: 'WEEKLY',
      scheduledTime: '09:30',
    })
  );
  actFlushSync(() => {
    mocks.agentMutationOptions?.onError?.(new Error('Change mode before retry'));
  });
  actFlushSync(() =>
    [...mounted.container.querySelectorAll('div')]
      .find((element) => element.textContent === 'Launch as Standard Workspace')
      ?.click()
  );
  actFlushSync(() =>
    [...mounted.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Launch')
      ?.click()
  );
  expect(mocks.createWorkspaceMutateMock).toHaveBeenCalledWith(
    expect.objectContaining({ ratchetEnabled: true })
  );
  actFlushSync(() => mounted.root.unmount());
});
